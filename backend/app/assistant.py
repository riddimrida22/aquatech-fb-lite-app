"""Ask AqtPM — natural-language company Q&A backed by Claude + the live company data.

The dashboard exposes a single "ask anything about the company" box. This module
gathers a comprehensive, current snapshot of the company (P&L, cash flow, balance
sheet, employee comp, payroll, AR, project performance, unbilled work, roster) by
calling the app's own reporting functions, then asks Claude to answer the question
against ONLY that data. Two modes: "quick" (concise) and "detailed" (thorough,
with charts). Requires ANTHROPIC_API_KEY in settings/env; degrades gracefully.
"""
from __future__ import annotations

import datetime
import inspect
import json
from decimal import Decimal
from typing import Any

# ---- context gathering ------------------------------------------------------

def _json_default(o: Any):
    if isinstance(o, (datetime.date, datetime.datetime)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    return str(o)


def _call_endpoint(fn, db):
    """Call a FastAPI endpoint function directly, filling only params it declares.

    Bypasses FastAPI's Depends() — passes the db session, None for date ranges and
    the injected User, and leaves everything else at its default.
    """
    kwargs = {}
    for name, p in inspect.signature(fn).parameters.items():
        ann = p.annotation
        if name == "db":
            kwargs["db"] = db
        elif name in ("start", "end", "start_date", "end_date"):
            kwargs[name] = None
        elif name in ("_", "user", "current_user", "actor") or (
            isinstance(ann, type) and getattr(ann, "__name__", "") == "User"
        ):
            kwargs[name] = None
        # else: rely on the parameter's own default
    return fn(**kwargs)


# label -> function name on app.main (missing ones are skipped gracefully)
_SOURCES = [
    ("profit_and_loss", "accounting_pl"),
    ("business_health", "accounting_business_health"),
    ("cash_flow", "accounting_cashflow"),
    ("balance_sheet", "accounting_balance_sheet"),
    ("employee_comp", "accounting_comp_reconciliation"),
    ("payroll_by_year", "payroll_journal_summary"),
    ("accounts_receivable", "ar_summary"),
    ("project_performance", "project_performance_range"),
    ("unbilled_work", "unbilled_hours_report"),
]


def build_company_context(db) -> dict:
    """Assemble a current snapshot of the whole company for the assistant."""
    import app.main as main  # lazy: avoid circular import at module load

    ctx: dict[str, Any] = {
        "as_of": datetime.date.today().isoformat(),
        "company": "Aquatech Engineering P.C.",
        "currency": "USD",
    }
    for label, fname in _SOURCES:
        fn = getattr(main, fname, None)
        if fn is None:
            continue
        try:
            ctx[label] = _call_endpoint(fn, db)
        except Exception as e:  # one bad source shouldn't sink the whole context
            ctx[label] = {"error": str(e)[:200]}

    # lightweight roster (names/roles) so people-questions can be answered
    try:
        from sqlalchemy import select
        from app.models import User as UserModel

        ctx["employee_roster"] = [
            {
                "name": getattr(u, "full_name", None),
                "role": getattr(u, "role", None),
                "active": bool(getattr(u, "is_active", True)),
            }
            for u in db.scalars(select(UserModel)).all()
        ]
    except Exception:
        pass
    return ctx


# ---- Claude call ------------------------------------------------------------

_CHART_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["bar", "line", "pie"]},
        "title": {"type": "string"},
        "unit": {"type": "string", "description": "e.g. '$', 'hrs', '%'"},
        "labels": {"type": "array", "items": {"type": "string"}},
        "series": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "data": {"type": "array", "items": {"type": "number"}},
                },
                "required": ["name", "data"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["type", "title", "unit", "labels", "series"],
    "additionalProperties": False,
}

_ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string", "description": "Answer in GitHub-flavored markdown."},
        "key_numbers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"label": {"type": "string"}, "value": {"type": "string"}},
                "required": ["label", "value"],
                "additionalProperties": False,
            },
        },
        "charts": {"type": "array", "items": _CHART_SCHEMA},
    },
    "required": ["answer", "key_numbers", "charts"],
    "additionalProperties": False,
}

_SYSTEM = """You are the internal financial & operations analyst for Aquatech Engineering P.C., a small consulting engineering firm. You answer the owner's questions about the company — its finances, accounts, employees, clients, projects, payroll, receivables, and cash — using ONLY the COMPANY DATA provided below.

Rules:
- Ground every claim in the data. Cite exact numbers (dollars in USD, hours, percentages). Never invent figures.
- If the data does not contain the answer, say so plainly and name what's missing — do not guess.
- All money is USD. Format as $12,345 (no decimals unless cents matter). Percentages to one decimal.
- {mode_instructions}

Return JSON matching the schema: `answer` (markdown), `key_numbers` (headline stats to highlight), `charts` (visualizations).

COMPANY DATA (JSON, current as of today):
{context}
"""

_QUICK = (
    "QUICK MODE: Be concise — 1-3 sentences or a single number with brief context. "
    "Put at most the 1-2 most relevant figures in key_numbers. Leave charts EMPTY unless the "
    "question explicitly asks to visualize."
)
_DETAILED = (
    "DETAILED MODE: Be thorough. Use markdown with short sections, tables, and bullet points where "
    "helpful. Populate key_numbers with 3-6 headline figures. Include 1-3 charts when the answer is "
    "quantitative and a chart genuinely aids understanding (e.g. breakdowns, trends, comparisons) — "
    "otherwise leave charts empty. Choose chart type sensibly (bar for comparisons, line for trends, "
    "pie for composition)."
)


def is_configured(settings) -> bool:
    return bool(getattr(settings, "ANTHROPIC_API_KEY", "") or "")


def ask(question: str, mode: str, db, settings) -> dict:
    """Answer a natural-language question about the company. Returns a dict with
    answer/key_numbers/charts, or {error, message} on failure."""
    if not is_configured(settings):
        return {
            "error": "not_configured",
            "message": "The AI assistant isn't set up yet. Add ANTHROPIC_API_KEY to the backend "
            "environment (.env) to enable it.",
        }
    mode = "detailed" if str(mode).lower().startswith("detail") else "quick"
    try:
        import anthropic
    except Exception:
        return {"error": "not_installed", "message": "The `anthropic` package isn't installed on the backend."}

    context = build_company_context(db)
    system = _SYSTEM.format(
        mode_instructions=(_DETAILED if mode == "detailed" else _QUICK),
        context=json.dumps(context, default=_json_default, ensure_ascii=False),
    )
    model = getattr(settings, "ASSISTANT_MODEL", "claude-opus-4-8") or "claude-opus-4-8"

    output_config: dict[str, Any] = {"format": {"type": "json_schema", "schema": _ANSWER_SCHEMA}}
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 8000 if mode == "detailed" else 1600,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": question.strip()[:2000]}],
        "output_config": output_config,
    }
    if mode == "detailed":
        kwargs["thinking"] = {"type": "adaptive"}
        output_config["effort"] = "high"
    else:
        # Quick = fast & cheap: no thinking (Sonnet 5 would otherwise think by default), low effort.
        kwargs["thinking"] = {"type": "disabled"}
        output_config["effort"] = "low"

    try:
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError:
        return {"error": "auth", "message": "The ANTHROPIC_API_KEY was rejected (invalid or revoked)."}
    except anthropic.RateLimitError:
        return {"error": "rate_limit", "message": "Rate limited by the Claude API. Try again in a moment."}
    except Exception as e:
        return {"error": "api", "message": f"Claude API error: {str(e)[:300]}"}

    if getattr(resp, "stop_reason", None) == "refusal":
        return {"error": "refusal", "message": "The assistant declined to answer that question."}

    text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), None)
    if not text:
        return {"error": "empty", "message": "The assistant returned an empty response."}
    try:
        data = json.loads(text)
    except Exception:
        # structured output should guarantee JSON, but never hard-fail the UI
        return {"answer": text, "key_numbers": [], "charts": [], "mode": mode, "model": model}

    data.setdefault("key_numbers", [])
    data.setdefault("charts", [])
    data["mode"] = mode
    data["model"] = model
    try:
        data["tokens"] = {"in": resp.usage.input_tokens, "out": resp.usage.output_tokens}
    except Exception:
        pass
    return data
