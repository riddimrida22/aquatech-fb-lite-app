"""Plaid Link token + transactions sync.

Plaid's flow is NOT OAuth-style. It's:
  1. Backend POSTs to /link/token/create -> link_token
  2. Frontend embeds Plaid Link JS, calls Plaid.create({token: link_token}).open()
  3. User picks bank, authenticates, Plaid Link returns public_token to frontend
  4. Frontend POSTs public_token to backend
  5. Backend exchanges public_token -> access_token via /item/public_token/exchange
  6. Backend stores access_token (long-lived, no refresh needed)
  7. Backend calls /transactions/sync to pull transactions

We use httpx directly against Plaid's REST API to avoid the Plaid Python SDK dep.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import BankAccount, BankConnection, BankTransaction, IntegrationToken, User
from .settings import get_settings

PROVIDER = "plaid"


def api_base() -> str:
    s = get_settings()
    env = (s.PLAID_ENV or "sandbox").lower()
    return {
        "sandbox": "https://sandbox.plaid.com",
        "development": "https://development.plaid.com",
        "production": "https://production.plaid.com",
    }.get(env, "https://sandbox.plaid.com")


def _common_payload() -> dict[str, str]:
    s = get_settings()
    return {
        "client_id": s.PLAID_CLIENT_ID,
        "secret": s.PLAID_SECRET,
    }


def create_link_token(client_user_id: str = "aqtpm-admin") -> str:
    """Generate a link_token to hand to the Plaid Link JS widget."""
    s = get_settings()
    products = [p.strip() for p in (s.PLAID_PRODUCTS or "transactions").split(",") if p.strip()]
    countries = [c.strip() for c in (s.PLAID_COUNTRY_CODES or "US").split(",") if c.strip()]
    payload = {
        **_common_payload(),
        "user": {"client_user_id": client_user_id},
        "client_name": "AquatechPM",
        "products": products,
        "country_codes": countries,
        "language": "en",
    }
    r = httpx.post(f"{api_base()}/link/token/create", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()["link_token"]


def exchange_public_token(public_token: str) -> dict[str, Any]:
    """Exchange a public_token (from Plaid Link) for a long-lived access_token."""
    payload = {**_common_payload(), "public_token": public_token}
    r = httpx.post(f"{api_base()}/item/public_token/exchange", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def get_accounts(access_token: str) -> dict[str, Any]:
    payload = {**_common_payload(), "access_token": access_token}
    r = httpx.post(f"{api_base()}/accounts/get", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def transactions_sync(access_token: str, cursor: str = "") -> dict[str, Any]:
    """Pull added/modified/removed transactions since the cursor."""
    payload = {**_common_payload(), "access_token": access_token}
    if cursor:
        payload["cursor"] = cursor
    r = httpx.post(f"{api_base()}/transactions/sync", json=payload, timeout=60)
    r.raise_for_status()
    return r.json()


def store_access_token(db: Session, exchange_response: dict[str, Any], notes: str = "") -> IntegrationToken:
    """Persist Plaid access_token + item_id."""
    access_token = exchange_response.get("access_token") or ""
    item_id = exchange_response.get("item_id") or ""
    row = db.scalar(select(IntegrationToken).where(IntegrationToken.provider == PROVIDER))
    if row is None:
        row = IntegrationToken(
            provider=PROVIDER,
            bearer_token=access_token,  # we reuse this column
            refresh_token="",            # Plaid doesn't have refresh tokens
        )
        db.add(row)
    else:
        row.bearer_token = access_token
        row.refresh_token = ""
    row.business_id = item_id
    row.account_id = item_id
    row.notes = notes or row.notes
    row.updated_at = datetime.utcnow()
    db.flush()
    return row


def load_token(db: Session) -> IntegrationToken | None:
    return db.scalar(select(IntegrationToken).where(IntegrationToken.provider == PROVIDER))


def _parse_date(s: Any) -> date | None:
    if not s:
        return None
    if isinstance(s, date):
        return s
    if isinstance(s, str):
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                return None
    return None


def _ensure_bank_connection(db: Session, item_id: str, accounts: list[dict[str, Any]]) -> BankConnection:
    """Find or create the BankConnection row for this Plaid item."""
    row = db.scalar(select(BankConnection).where(BankConnection.item_id == item_id))
    if row is None:
        # Pick a user_id for ownership — first admin in the system is fine
        owner = db.scalar(select(User).where(User.role == "admin"))
        if owner is None:
            owner = db.scalar(select(User))  # fall back to any user
        if owner is None:
            raise RuntimeError("No User row exists — cannot create BankConnection without owner")
        # Try to infer institution name from the first account
        inst_name = ""
        if accounts:
            inst_name = (accounts[0].get("official_name") or accounts[0].get("name") or "").split(" - ")[0]
        row = BankConnection(
            provider="plaid",
            user_id=owner.id,
            institution_name=inst_name or "Plaid bank",
            item_id=item_id,
            status="connected",
        )
        db.add(row)
        db.flush()
    return row


def _persist_account(db: Session, conn: BankConnection, a: dict[str, Any]) -> BankAccount:
    """Upsert a Plaid account into bank_accounts."""
    pid = a.get("account_id") or ""
    row = db.scalar(
        select(BankAccount).where(BankAccount.connection_id == conn.id, BankAccount.account_id == pid)
    )
    if row is None:
        row = BankAccount(connection_id=conn.id, account_id=pid)
        db.add(row)
    bal = a.get("balances") or {}
    row.name = a.get("name") or row.name or ""
    row.mask = a.get("mask") or row.mask
    row.type = a.get("type") or row.type
    row.subtype = a.get("subtype") or row.subtype
    row.iso_currency_code = bal.get("iso_currency_code") or row.iso_currency_code
    row.current_balance = bal.get("current") if bal.get("current") is not None else row.current_balance
    row.available_balance = bal.get("available") if bal.get("available") is not None else row.available_balance
    row.last_synced_at = datetime.utcnow()
    db.flush()
    return row


def _persist_transaction(db: Session, conn: BankConnection, t: dict[str, Any]) -> str:
    """Upsert a single Plaid transaction. Returns 'inserted' | 'updated'."""
    txid = t.get("transaction_id") or ""
    if not txid:
        raise ValueError("Plaid transaction missing transaction_id")
    row = db.scalar(
        select(BankTransaction).where(
            BankTransaction.connection_id == conn.id,
            BankTransaction.transaction_id == txid,
        )
    )
    outcome = "updated"
    if row is None:
        row = BankTransaction(connection_id=conn.id, transaction_id=txid, account_id=t.get("account_id") or "")
        db.add(row)
        outcome = "inserted"

    # Plaid sign convention: positive amount = money OUT (debit), negative = money IN.
    # Aqt convention (csv_chase): positive = money IN, negative = money OUT.
    # Flip the sign so our P&L math doesn't get confused.
    plaid_amt = t.get("amount")
    amount = -float(plaid_amt) if plaid_amt is not None else 0.0

    pfc = t.get("personal_finance_category") or {}
    cat_list = [pfc.get("primary"), pfc.get("detailed")]
    cat_list = [c for c in cat_list if c]
    if not cat_list:
        cat_list = t.get("category") or []

    row.account_id = t.get("account_id") or row.account_id
    row.posted_date = _parse_date(t.get("authorized_date") or t.get("date"))
    row.name = (t.get("name") or "")[:255]
    row.merchant_name = (t.get("merchant_name") or "")[:255] or None
    row.amount = amount
    row.iso_currency_code = t.get("iso_currency_code") or row.iso_currency_code
    row.pending = bool(t.get("pending", False))
    row.is_business = True
    row.category_json = json.dumps(cat_list)
    row.raw_json = json.dumps(t)[:8000]  # cap raw blob size
    row.source = "plaid_api"
    db.flush()
    return outcome


def sync_summary(db: Session) -> dict[str, Any]:
    row = load_token(db)
    if not row:
        raise RuntimeError("No Plaid item connected — link a bank via Plaid Link first")
    summary: dict[str, Any] = {"item_id": row.business_id}
    accounts: list[dict[str, Any]] = []
    try:
        accts = get_accounts(row.bearer_token)
        accounts = accts.get("accounts") or []
        summary["accounts"] = {
            "count": len(accounts),
            "sample": [
                {
                    "id": a.get("account_id"),
                    "name": a.get("name"),
                    "type": a.get("type"),
                    "subtype": a.get("subtype"),
                    "balance": (a.get("balances") or {}).get("current"),
                    "mask": a.get("mask"),
                }
                for a in accounts[:10]
            ],
        }
    except Exception as e:
        summary["accounts"] = {"error": str(e)}

    # Persist BankConnection + BankAccount rows from accounts payload
    bank_conn: BankConnection | None = None
    try:
        bank_conn = _ensure_bank_connection(db, row.business_id or "", accounts)
        for a in accounts:
            _persist_account(db, bank_conn, a)
        bank_conn.last_synced_at = datetime.utcnow()
        db.flush()
    except Exception as e:
        summary["accounts_persist_error"] = str(e)

    # Persist transactions
    counts = {"inserted": 0, "updated": 0, "errors": 0}
    sample: list[dict[str, Any]] = []
    next_cursor = ""
    try:
        prior = json.loads(row.last_sync_summary or "{}")
        next_cursor = prior.get("transactions_cursor") or ""
        if bank_conn is None:
            raise RuntimeError("No BankConnection — accounts step failed")
        for _ in range(20):  # up to 20 pages — first sync has years of history
            tx = transactions_sync(row.bearer_token, cursor=next_cursor)
            for t in tx.get("added") or []:
                try:
                    outcome = _persist_transaction(db, bank_conn, t)
                    counts[outcome] += 1
                except Exception as exc:
                    counts["errors"] += 1
                    if len(sample) < 3:
                        sample.append({"transaction_id": t.get("transaction_id"), "error": str(exc)})
                    continue
                if len(sample) < 5:
                    sample.append({
                        "id": t.get("transaction_id"),
                        "date": t.get("date"),
                        "name": t.get("name"),
                        "amount": t.get("amount"),
                        "outcome": outcome,
                    })
            for t in tx.get("modified") or []:
                try:
                    outcome = _persist_transaction(db, bank_conn, t)  # treat modified same as upsert
                    counts[outcome] += 1
                except Exception as exc:
                    counts["errors"] += 1
            next_cursor = tx.get("next_cursor") or ""
            if not tx.get("has_more"):
                break
        summary["transactions"] = {
            "by_outcome": counts,
            "next_cursor": next_cursor,
            "sample": sample,
        }
        summary["transactions_cursor"] = next_cursor
    except Exception as e:
        summary["transactions"] = {"error": str(e), "by_outcome": counts}

    row.last_synced_at = datetime.utcnow()
    row.last_sync_status = (
        "ok" if "error" not in (summary.get("accounts", {}) or {}) and "error" not in (summary.get("transactions", {}) or {}) else "partial"
    )
    row.last_sync_summary = json.dumps(summary)
    db.commit()
    return summary
