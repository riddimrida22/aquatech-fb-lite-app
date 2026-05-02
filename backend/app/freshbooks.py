"""FreshBooks OAuth + API client.

Reference docs:
  - Auth URL: https://auth.freshbooks.com/oauth/authorize/?response_type=code&...
  - Token exchange: POST https://api.freshbooks.com/auth/oauth/token
  - API base: https://api.freshbooks.com
"""
from __future__ import annotations

import json
import re
import urllib.parse
from datetime import date, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import IntegrationToken, Invoice, Project, ProjectExpense
from .settings import get_settings

PROVIDER = "freshbooks"
AUTHORIZE_URL = "https://auth.freshbooks.com/oauth/authorize/"
TOKEN_URL = "https://api.freshbooks.com/auth/oauth/token"
API_BASE = "https://api.freshbooks.com"


# ---------- OAuth helpers ----------


def authorize_url(state: str = "") -> str:
    """Build the URL we redirect the user to for OAuth consent."""
    s = get_settings()
    qs = {
        "response_type": "code",
        "client_id": s.FRESHBOOKS_CLIENT_ID,
        "redirect_uri": s.FRESHBOOKS_REDIRECT_URI,
    }
    if state:
        qs["state"] = state
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(qs)}"


def exchange_code(code: str) -> dict[str, Any]:
    """Exchange an authorization code for bearer + refresh tokens."""
    s = get_settings()
    payload = {
        "grant_type": "authorization_code",
        "client_id": s.FRESHBOOKS_CLIENT_ID,
        "client_secret": s.FRESHBOOKS_CLIENT_SECRET,
        "code": code,
        "redirect_uri": s.FRESHBOOKS_REDIRECT_URI,
    }
    r = httpx.post(TOKEN_URL, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def refresh_bearer(refresh_token: str) -> dict[str, Any]:
    """Refresh the bearer token using the refresh token (one-time use)."""
    s = get_settings()
    payload = {
        "grant_type": "refresh_token",
        "client_id": s.FRESHBOOKS_CLIENT_ID,
        "client_secret": s.FRESHBOOKS_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "redirect_uri": s.FRESHBOOKS_REDIRECT_URI,
    }
    r = httpx.post(TOKEN_URL, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def store_tokens(db: Session, token_response: dict[str, Any], notes: str = "") -> IntegrationToken:
    """Persist (or update) the FreshBooks token row."""
    bearer = token_response.get("access_token") or ""
    refresh = token_response.get("refresh_token") or ""
    expires_in = int(token_response.get("expires_in") or 0)
    expires_at = datetime.utcnow() + timedelta(seconds=expires_in) if expires_in else None
    row = db.scalar(select(IntegrationToken).where(IntegrationToken.provider == PROVIDER))
    if row is None:
        row = IntegrationToken(provider=PROVIDER, bearer_token=bearer, refresh_token=refresh)
        db.add(row)
    else:
        row.bearer_token = bearer
        row.refresh_token = refresh
    row.expires_at = expires_at
    row.notes = notes or row.notes
    row.updated_at = datetime.utcnow()
    db.flush()
    return row


def load_token(db: Session) -> IntegrationToken | None:
    return db.scalar(select(IntegrationToken).where(IntegrationToken.provider == PROVIDER))


def fetch_identity(bearer: str) -> dict[str, Any]:
    """Hit /auth/api/v1/users/me to learn the account_id (called business_id by FB)."""
    s = get_settings()
    r = httpx.get(
        f"{API_BASE}/auth/api/v1/users/me",
        headers={
            "Authorization": f"Bearer {bearer}",
            "Api-Version": s.FRESHBOOKS_API_VERSION,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def ensure_active_token(db: Session) -> IntegrationToken:
    """Make sure the stored token is current (refresh if expired). Returns the row."""
    row = load_token(db)
    if not row:
        raise RuntimeError("No FreshBooks token stored — connect first via /auth/freshbooks/start")
    if row.expires_at and row.expires_at <= datetime.utcnow() + timedelta(minutes=2):
        # refresh
        new_resp = refresh_bearer(row.refresh_token)
        store_tokens(db, new_resp, notes=row.notes)
        db.commit()
        row = load_token(db)
    return row


# ---------- API client ----------


def api_get(db: Session, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Authenticated GET against the FreshBooks API. Auto-refreshes if needed."""
    s = get_settings()
    row = ensure_active_token(db)
    url = path if path.startswith("http") else f"{API_BASE}{path}"
    r = httpx.get(
        url,
        headers={
            "Authorization": f"Bearer {row.bearer_token}",
            "Api-Version": s.FRESHBOOKS_API_VERSION,
            "Content-Type": "application/json",
        },
        params=params or {},
        timeout=60,
    )
    if r.status_code == 401:
        # Force a refresh attempt and try once more
        new_resp = refresh_bearer(row.refresh_token)
        store_tokens(db, new_resp, notes=row.notes)
        db.commit()
        row = load_token(db)
        r = httpx.get(
            url,
            headers={
                "Authorization": f"Bearer {row.bearer_token}",
                "Api-Version": s.FRESHBOOKS_API_VERSION,
                "Content-Type": "application/json",
            },
            params=params or {},
            timeout=60,
        )
    r.raise_for_status()
    return r.json()


# ---------- Field helpers ----------


def _money(node: Any) -> float:
    """Pull a float out of a FreshBooks money object {"amount": "1234.56", "code": "USD"}.

    Also handles plain numerics or strings just in case.
    """
    if node is None:
        return 0.0
    if isinstance(node, (int, float)):
        return float(node)
    if isinstance(node, str):
        try:
            return float(node)
        except ValueError:
            return 0.0
    if isinstance(node, dict):
        return _money(node.get("amount"))
    return 0.0


def _parse_date(s: Any) -> date | None:
    if not s:
        return None
    if isinstance(s, date):
        return s
    if isinstance(s, str):
        # FB returns "YYYY-MM-DD" most places, sometimes ISO with time
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                return None
    return None


def _fb_status_to_app(fb_status: str | None, paid: float, total: float) -> str:
    """Map FreshBooks v3_status / display_status to AqtPM invoice status.

    AqtPM uses: draft | sent | paid | overdue | partial.
    """
    s = (fb_status or "").strip().lower()
    if s in ("paid",):
        return "paid"
    if s in ("draft", "drafted"):
        return "draft"
    if s in ("sent", "sent_unpaid", "viewed", "outstanding"):
        # If partially paid, prefer "partial"
        if 0 < paid < total:
            return "partial"
        return "sent"
    if s in ("overdue", "late"):
        return "overdue"
    if s in ("partial",):
        return "partial"
    if s in ("paid_offline",):
        return "paid"
    # Fallback by money:
    if total > 0 and paid >= total:
        return "paid"
    if 0 < paid < total:
        return "partial"
    return "sent"


def _project_id_for(db: Session, invoice_number: str, organization: str) -> int | None:
    """Best-effort project lookup. Tries:
    1. Existing CSV-imported invoice with same invoice_number — reuse its project_id.
    2. Project with name == organization (exact match).
    Returns None if no confident match — invoice still imports, project_id stays null.
    """
    if invoice_number:
        existing = db.scalar(select(Invoice).where(Invoice.invoice_number == invoice_number))
        if existing and existing.project_id:
            return existing.project_id
    if organization:
        proj = db.scalar(select(Project).where(Project.name == organization))
        if proj:
            return proj.id
    return None


# ---------- Sync helpers ----------


def sync_clients(db: Session, account_id: str) -> dict[str, Any]:
    """Read-only enumeration of clients. Currently we don't have a Client table —
    AqtPM stores client_name as a string on Invoice and Project, so we just count.
    """
    page = 1
    total_seen = 0
    sample = []
    while True:
        resp = api_get(
            db,
            f"/accounting/account/{account_id}/users/clients",
            params={"page": page, "per_page": 50},
        )
        data = resp.get("response", {}).get("result", {})
        clients = data.get("clients") or []
        for c in clients:
            total_seen += 1
            if len(sample) < 5:
                sample.append({
                    "id": c.get("id"),
                    "organization": c.get("organization"),
                    "email": c.get("email"),
                })
        pages = int(data.get("pages") or 1)
        if page >= pages:
            break
        page += 1
    return {"count": total_seen, "sample": sample}


def _persist_invoice(db: Session, inv: dict[str, Any]) -> str:
    """Upsert a single FreshBooks invoice into Aqt's invoices table.

    Returns one of: 'inserted' | 'updated' | 'claimed'.
      - inserted: brand new row
      - updated:  matched by external_id, fields refreshed
      - claimed:  matched by invoice_number against a csv-sourced row, now retagged
                  as freshbooks_api with external_id set
    """
    fb_id = str(inv.get("id") or "")
    invoice_number = (inv.get("invoice_number") or "").strip()
    if not fb_id:
        # Without a stable FB id we can't safely upsert
        raise ValueError("FreshBooks invoice missing id")

    total = _money(inv.get("amount"))
    paid = _money(inv.get("paid"))
    outstanding = _money(inv.get("outstanding"))
    if outstanding == 0.0 and total > 0:
        outstanding = max(total - paid, 0.0)
    status = _fb_status_to_app(inv.get("v3_status") or inv.get("display_status") or inv.get("status"), paid, total)
    create_d = _parse_date(inv.get("create_date")) or _parse_date(inv.get("date")) or date.today()
    due_d = _parse_date(inv.get("due_date")) or create_d
    organization = (inv.get("organization") or inv.get("current_organization") or "").strip()

    # 1) Match by external_id (already-claimed FB invoice)
    row = db.scalar(select(Invoice).where(Invoice.external_id == fb_id, Invoice.source == "freshbooks_api"))
    outcome = "updated"
    if row is None and invoice_number:
        # 2) Match by invoice_number (CSV-imported predecessor) — claim it
        candidate = db.scalar(select(Invoice).where(Invoice.invoice_number == invoice_number))
        if candidate is not None:
            row = candidate
            outcome = "claimed"
    if row is None:
        # 3) Brand new
        row = Invoice(
            invoice_number=invoice_number or f"FB-{fb_id}",
            issue_date=create_d,
            due_date=due_d,
            start_date=create_d,
            end_date=create_d,
        )
        db.add(row)
        outcome = "inserted"

    # Refresh fields (in all three branches)
    row.source = "freshbooks_api"
    row.external_id = fb_id
    if invoice_number:
        row.invoice_number = invoice_number
    if organization:
        row.client_name = organization
    if not row.project_id:
        proj_id = _project_id_for(db, invoice_number, organization)
        if proj_id:
            row.project_id = proj_id
    row.subtotal_amount = total
    row.amount_paid = paid
    row.balance_due = outstanding
    row.status = status
    row.issue_date = create_d
    row.due_date = due_d
    if outcome == "inserted":
        row.start_date = create_d
        row.end_date = create_d
    if status == "paid":
        # FreshBooks doesn't expose a single "paid_date" — best proxy is updated_at if present
        upd = _parse_date(inv.get("updated"))
        if upd:
            row.paid_date = upd

    db.flush()
    return outcome


def sync_invoices(db: Session, account_id: str) -> dict[str, Any]:
    page = 1
    counts = {"inserted": 0, "updated": 0, "claimed": 0, "errors": 0}
    sample: list[dict[str, Any]] = []
    while True:
        resp = api_get(
            db,
            f"/accounting/account/{account_id}/invoices/invoices",
            params={"page": page, "per_page": 50},
        )
        data = resp.get("response", {}).get("result", {})
        invoices = data.get("invoices") or []
        for inv in invoices:
            try:
                outcome = _persist_invoice(db, inv)
                counts[outcome] = counts.get(outcome, 0) + 1
            except Exception as e:
                counts["errors"] += 1
                if len(sample) < 3:
                    sample.append({"id": inv.get("id"), "error": str(e)})
                continue
            if len(sample) < 5:
                sample.append({
                    "id": inv.get("id"),
                    "invoice_number": inv.get("invoice_number"),
                    "outcome": outcome,
                })
        pages = int(data.get("pages") or 1)
        if page >= pages:
            break
        page += 1
    db.flush()
    return {"count": sum(counts.values()) - counts["errors"], "by_outcome": counts, "sample": sample}


def _persist_expense(db: Session, exp: dict[str, Any]) -> str:
    """Upsert a single FreshBooks expense into project_expenses.

    Match strategy:
      - external_id == fb id  → update
      - else                  → insert
    (We don't claim CSV-sourced expense rows because matching is brittle.)
    """
    fb_id = str(exp.get("id") or "")
    if not fb_id:
        raise ValueError("FreshBooks expense missing id")
    amt = _money(exp.get("amount"))
    exp_date = _parse_date(exp.get("date")) or date.today()
    notes = (exp.get("notes") or exp.get("vendor") or "").strip()
    category = "General"
    cat_id = exp.get("categoryid")
    if cat_id:
        category = f"FB-cat-{cat_id}"

    row = db.scalar(select(ProjectExpense).where(ProjectExpense.external_id == fb_id, ProjectExpense.source == "freshbooks_api"))
    outcome = "updated"
    if row is None:
        # Try project hint via FB projectid → AqtPM project (FB projectid is a separate FB id we don't track yet)
        # For now, expenses without a matching project go to overhead project (project_id=1 is convention if it exists).
        proj_id = 0
        # Use the first active project as a placeholder when nothing else maps;
        # the user will reassign post-import. SQLAlchemy will reject project_id=0 if FK enforces — try None first.
        # ProjectExpense.project_id is non-null FK; use a sentinel "Unassigned (FB API)" project.
        unassigned = db.scalar(select(Project).where(Project.name == "Unassigned (FB API)"))
        if unassigned is None:
            unassigned = Project(name="Unassigned (FB API)", is_overhead=True, is_billable=False, lifecycle_status="active")
            db.add(unassigned)
            db.flush()
        proj_id = unassigned.id
        row = ProjectExpense(project_id=proj_id, expense_date=exp_date)
        db.add(row)
        outcome = "inserted"

    row.source = "freshbooks_api"
    row.external_id = fb_id
    row.amount = amt
    row.expense_date = exp_date
    row.category = category
    if notes:
        row.description = notes[:255]
    db.flush()
    return outcome


def sync_expenses(db: Session, account_id: str) -> dict[str, Any]:
    page = 1
    counts = {"inserted": 0, "updated": 0, "errors": 0}
    sample: list[dict[str, Any]] = []
    while True:
        resp = api_get(
            db,
            f"/accounting/account/{account_id}/expenses/expenses",
            params={"page": page, "per_page": 50},
        )
        data = resp.get("response", {}).get("result", {})
        expenses = data.get("expenses") or []
        for e in expenses:
            try:
                outcome = _persist_expense(db, e)
                counts[outcome] = counts.get(outcome, 0) + 1
            except Exception as exc:
                counts["errors"] += 1
                if len(sample) < 3:
                    sample.append({"id": e.get("id"), "error": str(exc)})
                continue
            if len(sample) < 5:
                sample.append({
                    "id": e.get("id"),
                    "amount": e.get("amount"),
                    "date": e.get("date"),
                    "outcome": outcome,
                })
        pages = int(data.get("pages") or 1)
        if page >= pages:
            break
        page += 1
    db.flush()
    return {"count": sum(counts.values()) - counts["errors"], "by_outcome": counts, "sample": sample}


def sync_summary(db: Session) -> dict[str, Any]:
    """Run all sync workers, return a summary. Updates last_synced_at on success."""
    row = ensure_active_token(db)
    if not row.account_id:
        # Fetch identity to populate account_id (called businessUuid in FB)
        ident = fetch_identity(row.bearer_token)
        # The identity payload has a businesses[] list — pick the first one's account_id
        biz = (ident.get("response", {}).get("business_memberships") or [])
        if biz:
            biz0 = biz[0].get("business") or {}
            row.account_id = biz0.get("account_id") or biz0.get("id") or ""
            row.business_id = biz0.get("id") or ""
            db.flush()
    if not row.account_id:
        raise RuntimeError("Could not determine FreshBooks account_id — re-authorize")

    summary: dict[str, Any] = {"account_id": row.account_id}
    try:
        summary["clients"] = sync_clients(db, row.account_id)
    except Exception as e:
        summary["clients"] = {"error": str(e)}
    try:
        summary["invoices"] = sync_invoices(db, row.account_id)
    except Exception as e:
        summary["invoices"] = {"error": str(e)}
    try:
        summary["expenses"] = sync_expenses(db, row.account_id)
    except Exception as e:
        summary["expenses"] = {"error": str(e)}

    row.last_synced_at = datetime.utcnow()
    row.last_sync_status = "ok" if all("error" not in v for v in (
        summary.get("clients", {}),
        summary.get("invoices", {}),
        summary.get("expenses", {}),
    )) else "partial"
    row.last_sync_summary = json.dumps(summary)
    db.commit()
    return summary
