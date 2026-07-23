"""Paychex Flex API client.

Auth model differs from FreshBooks/Gusto: Paychex uses OAuth 2.0
**client_credentials** with a company-owned app created under
Company Settings -> Integrated apps -> Create app. There is no user redirect
and no refresh token — the token simply expires (~1h), so we cache it in
memory and re-acquire proactively before expiry.

Scope is granted per API resource in the Paychex app's Access settings.
A newly created app typically only has `read:company_people`, so payroll and
check endpoints return HTTP 403 with error code API-2 until Payroll/Checks are
enabled. `capabilities()` probes for exactly that so the UI can show which
resources are live rather than failing opaquely.
"""

from __future__ import annotations

import threading
import time
import urllib.parse
from datetime import datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import IntegrationToken
from .settings import get_settings

PROVIDER = "paychex"
TOKEN_PATH = "/auth/oauth/v2/token"

# Token cache — client_credentials tokens are app-wide, not per-user.
_token_lock = threading.Lock()
_token_cache: dict[str, Any] = {"access_token": "", "expires_at": 0.0, "scope": ""}


def api_base() -> str:
    return (get_settings().PAYCHEX_API_BASE or "https://api.paychex.com").rstrip("/")


def is_configured() -> bool:
    s = get_settings()
    return bool(s.PAYCHEX_CLIENT_ID and s.PAYCHEX_CLIENT_SECRET)


def get_access_token(force: bool = False) -> str:
    """Return a valid bearer token, re-acquiring when it is close to expiry.

    Paychex issues no refresh token, so we renew with a 60s safety margin
    rather than waiting for a mid-request 401.
    """
    s = get_settings()
    if not is_configured():
        raise RuntimeError("Paychex not configured — set PAYCHEX_CLIENT_ID / PAYCHEX_CLIENT_SECRET")
    with _token_lock:
        if not force and _token_cache["access_token"] and time.time() < float(_token_cache["expires_at"]) - 60:
            return str(_token_cache["access_token"])
        body = urllib.parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": s.PAYCHEX_CLIENT_ID,
                "client_secret": s.PAYCHEX_CLIENT_SECRET,
            }
        )
        r = httpx.post(
            f"{api_base()}{TOKEN_PATH}",
            content=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
        r.raise_for_status()
        d = r.json()
        _token_cache["access_token"] = d.get("access_token") or ""
        _token_cache["expires_at"] = time.time() + float(d.get("expires_in") or 3600)
        _token_cache["scope"] = d.get("scope") or ""
        return str(_token_cache["access_token"])


def current_scope() -> str:
    """Scope from the last token exchange (empty until first call)."""
    return str(_token_cache.get("scope") or "")


def api_get(path: str, params: dict[str, Any] | None = None) -> tuple[int, Any]:
    """GET a Paychex resource. Returns (status_code, parsed_or_text).

    Never raises on 4xx — a 403 here means "resource not enabled in the app's
    Access settings", which is a normal state we want to surface, not a crash.
    """
    token = get_access_token()
    r = httpx.get(
        f"{api_base()}{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=45,
    )
    if r.status_code == 401:  # token rejected — force one clean retry
        token = get_access_token(force=True)
        r = httpx.get(
            f"{api_base()}{path}",
            params=params or {},
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=45,
        )
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text[:400]


def get_companies() -> list[dict[str, Any]]:
    sc, d = api_get("/companies")
    if sc != 200 or not isinstance(d, dict):
        return []
    return list(d.get("content") or [])


def primary_company() -> dict[str, Any] | None:
    c = get_companies()
    return c[0] if c else None


def capabilities(company_id: str) -> dict[str, dict[str, Any]]:
    """Probe which Paychex resources this app is actually entitled to.

    Payroll/Checks stay 403 until enabled in Access settings, so this is the
    signal the UI uses to tell the owner what still needs turning on.
    """
    probes = {
        "workers": f"/companies/{company_id}/workers",
        "payperiods": f"/companies/{company_id}/payperiods",
        "payrolls": f"/companies/{company_id}/payrolls",
        "checks": f"/companies/{company_id}/checks",
    }
    out: dict[str, dict[str, Any]] = {}
    for name, path in probes.items():
        sc, d = api_get(path, {"limit": 1})
        count = len(d.get("content") or []) if (sc == 200 and isinstance(d, dict)) else None
        out[name] = {
            "status": sc,
            "allowed": sc == 200,
            "count": count,
            "note": "" if sc == 200 else ("not authorized — enable this resource in Paychex Access settings" if sc == 403 else str(d)[:120]),
        }
    return out


def load_token(db: Session) -> IntegrationToken | None:
    return db.scalar(select(IntegrationToken).where(IntegrationToken.provider == PROVIDER))


def _record(db: Session, company: dict[str, Any] | None, status: str, summary: str) -> IntegrationToken:
    """Persist connection state so the UI can show it without hitting Paychex."""
    row = load_token(db)
    if row is None:
        row = IntegrationToken(provider=PROVIDER, bearer_token="", refresh_token="")
        db.add(row)
    # The access_token is short-lived and re-acquired from the client secret,
    # so there is nothing durable worth storing in bearer_token.
    row.bearer_token = ""
    row.refresh_token = ""
    row.account_id = str((company or {}).get("companyId") or "") or None
    row.business_id = str((company or {}).get("displayId") or "") or None
    row.last_synced_at = datetime.utcnow()
    row.last_sync_status = status
    row.last_sync_summary = summary
    row.notes = row.notes or "Paychex Flex app (client_credentials)"
    row.updated_at = datetime.utcnow()
    db.flush()
    return row


def sync_summary(db: Session) -> dict[str, Any]:
    """Connect, identify the company, and report what this app can reach.

    Payroll ingestion is intentionally NOT implemented yet: the payroll/checks
    endpoints are still 403 for this app, so their response shape is unverified.
    Mapping them into COGS blind would be guesswork — that lands once the scope
    is granted and a real payload can be inspected.
    """
    import json as _json

    if not is_configured():
        raise RuntimeError("Paychex not configured — set PAYCHEX_CLIENT_ID / PAYCHEX_CLIENT_SECRET")

    get_access_token()
    company = primary_company()
    if not company:
        summary = {"error": "authenticated but no company returned"}
        _record(db, None, "error", _json.dumps(summary))
        db.commit()
        return summary

    company_id = str(company.get("companyId") or "")
    caps = capabilities(company_id)
    payroll_ready = bool(caps.get("payrolls", {}).get("allowed") and caps.get("checks", {}).get("allowed"))
    summary: dict[str, Any] = {
        "company": {
            "companyId": company_id,
            "displayId": company.get("displayId"),
            "name": company.get("legalName") or company.get("name"),
        },
        "scope": current_scope(),
        "capabilities": caps,
        "payroll_ready": payroll_ready,
        "pending": [k for k, v in caps.items() if not v.get("allowed")],
        "note": (
            "Payroll + Checks enabled — ready to wire payroll into COGS."
            if payroll_ready
            else "Payroll/Checks not yet authorized. Enable them in Paychex: "
                 "Company Settings > Integrated apps > your app > Access settings."
        ),
    }
    _record(db, company, "ok" if payroll_ready else "partial", _json.dumps(summary))
    db.commit()
    return summary
