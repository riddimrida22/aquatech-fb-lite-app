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
from datetime import datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import IntegrationToken
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


def sync_summary(db: Session) -> dict[str, Any]:
    row = load_token(db)
    if not row:
        raise RuntimeError("No Plaid item connected — link a bank via Plaid Link first")
    summary: dict[str, Any] = {"item_id": row.business_id}
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
    try:
        # Pull a first batch of transactions; cursor stored in last_sync_summary for incremental
        prior = json.loads(row.last_sync_summary or "{}")
        cursor = prior.get("transactions_cursor") or ""
        added: list[Any] = []
        next_cursor = cursor
        for _ in range(5):  # safety: at most 5 pages this run
            tx = transactions_sync(row.bearer_token, cursor=next_cursor)
            added.extend(tx.get("added") or [])
            next_cursor = tx.get("next_cursor") or ""
            if not tx.get("has_more"):
                break
        summary["transactions"] = {
            "added_count": len(added),
            "next_cursor": next_cursor,
            "sample": [
                {
                    "id": t.get("transaction_id"),
                    "date": t.get("date"),
                    "name": t.get("name"),
                    "amount": t.get("amount"),
                    "category": t.get("personal_finance_category", {}).get("primary"),
                }
                for t in added[:10]
            ],
        }
        summary["transactions_cursor"] = next_cursor  # for next sync
    except Exception as e:
        summary["transactions"] = {"error": str(e)}

    row.last_synced_at = datetime.utcnow()
    row.last_sync_status = (
        "ok" if all("error" not in (v or {}) for v in (summary.get("accounts", {}), summary.get("transactions", {}))) else "partial"
    )
    row.last_sync_summary = json.dumps(summary)
    db.commit()
    return summary
