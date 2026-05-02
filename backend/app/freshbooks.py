"""FreshBooks OAuth + API client.

Reference docs:
  - Auth URL: https://auth.freshbooks.com/oauth/authorize/?response_type=code&...
  - Token exchange: POST https://api.freshbooks.com/auth/oauth/token
  - API base: https://api.freshbooks.com
"""
from __future__ import annotations

import json
import urllib.parse
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import IntegrationToken
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


# ---------- Sync helpers (read-only for now) ----------


def sync_clients(db: Session, account_id: str) -> dict[str, Any]:
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


def sync_invoices(db: Session, account_id: str) -> dict[str, Any]:
    page = 1
    total_seen = 0
    sample = []
    while True:
        resp = api_get(
            db,
            f"/accounting/account/{account_id}/invoices/invoices",
            params={"page": page, "per_page": 50},
        )
        data = resp.get("response", {}).get("result", {})
        invoices = data.get("invoices") or []
        for inv in invoices:
            total_seen += 1
            if len(sample) < 5:
                sample.append({
                    "id": inv.get("id"),
                    "invoice_number": inv.get("invoice_number"),
                    "amount": inv.get("amount"),
                    "status": inv.get("display_status"),
                })
        pages = int(data.get("pages") or 1)
        if page >= pages:
            break
        page += 1
    return {"count": total_seen, "sample": sample}


def sync_expenses(db: Session, account_id: str) -> dict[str, Any]:
    page = 1
    total_seen = 0
    sample = []
    while True:
        resp = api_get(
            db,
            f"/accounting/account/{account_id}/expenses/expenses",
            params={"page": page, "per_page": 50},
        )
        data = resp.get("response", {}).get("result", {})
        expenses = data.get("expenses") or []
        for e in expenses:
            total_seen += 1
            if len(sample) < 5:
                sample.append({
                    "id": e.get("id"),
                    "amount": e.get("amount"),
                    "date": e.get("date"),
                    "categoryid": e.get("categoryid"),
                })
        pages = int(data.get("pages") or 1)
        if page >= pages:
            break
        page += 1
    return {"count": total_seen, "sample": sample}


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
