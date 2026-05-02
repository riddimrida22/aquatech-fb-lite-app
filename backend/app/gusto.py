"""Gusto OAuth + API client.

Mirrors the structure of freshbooks.py. For the demo app we hit api.gusto-demo.com.
When the app is promoted to production at Gusto, flip GUSTO_API_BASE in the env.

Key endpoints (from Gusto's docs):
  Authorize: {GUSTO_AUTH_BASE}/oauth/authorize
  Token    : {GUSTO_API_BASE}/oauth/token
  Companies: GET /v1/companies
  Employees: GET /v1/companies/{company_uuid}/employees
  Payrolls : GET /v1/companies/{company_uuid}/payrolls
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

PROVIDER = "gusto"


# ---------- OAuth helpers ----------


def authorize_url(state: str = "") -> str:
    s = get_settings()
    qs = {
        "response_type": "code",
        "client_id": s.GUSTO_CLIENT_ID,
        "redirect_uri": s.GUSTO_REDIRECT_URI,
    }
    if state:
        qs["state"] = state
    return f"{s.GUSTO_AUTH_BASE}/oauth/authorize?{urllib.parse.urlencode(qs)}"


def exchange_code(code: str) -> dict[str, Any]:
    s = get_settings()
    payload = {
        "grant_type": "authorization_code",
        "client_id": s.GUSTO_CLIENT_ID,
        "client_secret": s.GUSTO_CLIENT_SECRET,
        "code": code,
        "redirect_uri": s.GUSTO_REDIRECT_URI,
    }
    r = httpx.post(f"{s.GUSTO_API_BASE}/oauth/token", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def refresh_bearer(refresh_token: str) -> dict[str, Any]:
    s = get_settings()
    payload = {
        "grant_type": "refresh_token",
        "client_id": s.GUSTO_CLIENT_ID,
        "client_secret": s.GUSTO_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "redirect_uri": s.GUSTO_REDIRECT_URI,
    }
    r = httpx.post(f"{s.GUSTO_API_BASE}/oauth/token", json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def store_tokens(db: Session, token_response: dict[str, Any], notes: str = "") -> IntegrationToken:
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


def ensure_active_token(db: Session) -> IntegrationToken:
    row = load_token(db)
    if not row:
        raise RuntimeError("No Gusto token stored — connect first via /auth/gusto/start")
    if row.expires_at and row.expires_at <= datetime.utcnow() + timedelta(minutes=2):
        new_resp = refresh_bearer(row.refresh_token)
        store_tokens(db, new_resp, notes=row.notes)
        db.commit()
        row = load_token(db)
    return row


# ---------- API client ----------


def api_get(db: Session, path: str, params: dict[str, Any] | None = None) -> Any:
    s = get_settings()
    row = ensure_active_token(db)
    url = path if path.startswith("http") else f"{s.GUSTO_API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {row.bearer_token}",
        "X-Gusto-API-Version": s.GUSTO_API_VERSION,
        "Accept": "application/json",
    }
    r = httpx.get(url, headers=headers, params=params or {}, timeout=60)
    if r.status_code == 401:
        new_resp = refresh_bearer(row.refresh_token)
        store_tokens(db, new_resp, notes=row.notes)
        db.commit()
        row = load_token(db)
        headers["Authorization"] = f"Bearer {row.bearer_token}"
        r = httpx.get(url, headers=headers, params=params or {}, timeout=60)
    r.raise_for_status()
    return r.json()


# ---------- Sync helpers ----------


def list_companies(db: Session) -> list[dict[str, Any]]:
    """Companies the connected user has access to (typically just the one)."""
    data = api_get(db, "/v1/companies")
    if isinstance(data, list):
        return data
    # Some Gusto responses wrap in an object
    if isinstance(data, dict) and "companies" in data:
        return data["companies"]
    return [data] if isinstance(data, dict) else []


def list_employees(db: Session, company_uuid: str) -> list[dict[str, Any]]:
    data = api_get(db, f"/v1/companies/{company_uuid}/employees")
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "employees" in data:
        return data["employees"]
    return []


def list_payrolls(db: Session, company_uuid: str) -> list[dict[str, Any]]:
    data = api_get(db, f"/v1/companies/{company_uuid}/payrolls")
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "payrolls" in data:
        return data["payrolls"]
    return []


def sync_summary(db: Session) -> dict[str, Any]:
    row = ensure_active_token(db)
    summary: dict[str, Any] = {}
    try:
        companies = list_companies(db)
        summary["companies"] = {
            "count": len(companies),
            "sample": [
                {"uuid": c.get("uuid") or c.get("id"), "name": c.get("name") or c.get("trade_name")}
                for c in companies[:5]
            ],
        }
        # Pick the first company for deeper sync
        if companies:
            primary = companies[0]
            uuid = primary.get("uuid") or primary.get("id")
            row.business_id = uuid
            row.account_id = uuid
            db.flush()
            try:
                emps = list_employees(db, uuid)
                summary["employees"] = {
                    "count": len(emps),
                    "sample": [
                        {
                            "uuid": e.get("uuid") or e.get("id"),
                            "first": e.get("first_name"),
                            "last": e.get("last_name"),
                        }
                        for e in emps[:5]
                    ],
                }
            except Exception as e:
                summary["employees"] = {"error": str(e)}
            try:
                pays = list_payrolls(db, uuid)
                summary["payrolls"] = {
                    "count": len(pays),
                    "sample": [
                        {
                            "uuid": p.get("uuid") or p.get("id"),
                            "check_date": p.get("check_date"),
                            "processed": p.get("processed"),
                        }
                        for p in pays[:3]
                    ],
                }
            except Exception as e:
                summary["payrolls"] = {"error": str(e)}
    except Exception as e:
        summary["companies"] = {"error": str(e)}

    row.last_synced_at = datetime.utcnow()
    row.last_sync_status = (
        "ok" if all("error" not in (v or {}) for v in summary.values()) else "partial"
    )
    row.last_sync_summary = json.dumps(summary)
    db.commit()
    return summary
