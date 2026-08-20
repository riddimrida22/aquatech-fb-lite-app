"""Ask AqtPM — natural-language company Q&A backed by Claude + the live company data.

The dashboard exposes a single "ask anything about the company" box. This module
gives Claude two ways to reach the data:

  1. A SNAPSHOT — a current roll-up of the company (P&L, cash flow, balance sheet,
     comp, payroll, AR, project performance, unbilled work, roster), assembled by
     calling the app's own reporting functions. Answers headline questions instantly.
  2. A read-only SQL tool (`run_sql`) — for anything the snapshot doesn't contain:
     specific invoices, breakdowns by person/project/period, individual time entries,
     the `finance` schema (loans, financing, unbilled, notes), bank transactions,
     expenses, clients, tasks. This is what lets the assistant retrieve the same
     detail an operator could by querying the DB directly.

Claude runs an agentic loop: read the question, query as needed, then return a
structured answer (markdown + key numbers + optional charts + answerability).
Requires ANTHROPIC_API_KEY; degrades gracefully.
"""
from __future__ import annotations

import datetime
import inspect
import json
import re
from decimal import Decimal
from typing import Any

# ---- serialization ----------------------------------------------------------

def _json_default(o: Any):
    if isinstance(o, (datetime.date, datetime.datetime)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    return str(o)


# ---- snapshot context gathering --------------------------------------------

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
    ("payroll_hours", "payroll_hours_report"),
    ("accounts_receivable", "ar_summary"),
    ("invoice_revenue_status", "invoice_revenue_status"),
    ("project_performance", "project_performance_range"),
    ("project_budgets", "project_budget_status"),
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


# ---- read-only SQL tool -----------------------------------------------------

# Defense-in-depth on top of the READ ONLY transaction below. Blocks writes, DDL,
# multi-statement, and superuser filesystem/shell escapes (COPY ... TO PROGRAM,
# lo_export, pg_read_file, dblink, etc.).
_BANNED = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|do|"
    r"vacuum|reindex|cluster|comment|copy|program|lo_import|lo_export|pg_read_file|"
    r"pg_read_binary_file|pg_ls_dir|pg_stat_file|dblink|pg_sleep|set_config|"
    r"pg_terminate_backend|pg_cancel_backend)\b",
    re.IGNORECASE,
)
_MAX_ROWS = 500


def _is_safe_select(sql: str) -> tuple[bool, str]:
    s = (sql or "").strip().rstrip(";").strip()
    if not s:
        return False, "empty query"
    low = s.lower()
    if not (low.startswith("select") or low.startswith("with")):
        return False, "only a single read-only SELECT/WITH query is allowed"
    if ";" in s:
        return False, "only one statement is allowed (no semicolons)"
    if _BANNED.search(s):
        return False, "query contains a disallowed keyword — this tool is read-only"
    return True, ""


def _run_readonly_sql(db, query: str) -> dict:
    """Execute a single SELECT in a READ ONLY transaction with a statement timeout
    and a hard row cap. Never mutates. Returns {columns, rows, row_count, truncated}
    or {error}."""
    ok, why = _is_safe_select(query)
    if not ok:
        return {"error": why}
    from sqlalchemy import text as _text
    try:
        conn = db.get_bind().connect()
    except Exception as e:
        return {"error": f"could not open a DB connection: {str(e)[:200]}"}
    try:
        trans = conn.begin()
        try:
            conn.execute(_text("SET TRANSACTION READ ONLY"))
            conn.execute(_text("SET LOCAL statement_timeout = '8000'"))
            res = conn.execute(_text(query))
            cols = list(res.keys())
            fetched = res.fetchmany(_MAX_ROWS + 1)
            truncated = len(fetched) > _MAX_ROWS
            fetched = fetched[:_MAX_ROWS]
            rows = [
                {c: _json_default(v) if isinstance(v, (datetime.date, datetime.datetime, Decimal)) else v
                 for c, v in zip(cols, r)}
                for r in fetched
            ]
            return {"columns": cols, "row_count": len(rows), "truncated": truncated, "rows": rows}
        finally:
            trans.rollback()  # read-only; nothing to commit
    except Exception as e:
        return {"error": str(e)[:400]}
    finally:
        conn.close()


_SCHEMA_CACHE: dict[str, Any] = {"text": None}


def _schema_catalog(db) -> str:
    """Compact `schema.table(col, col, ...)` catalog for public + finance schemas so
    Claude can write correct SQL. Cached for the process."""
    if _SCHEMA_CACHE["text"]:
        return _SCHEMA_CACHE["text"]
    from sqlalchemy import text as _text
    try:
        rows = db.execute(_text(
            """
            SELECT table_schema, table_name,
                   string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
            FROM information_schema.columns
            WHERE table_schema IN ('public', 'finance')
            GROUP BY table_schema, table_name
            ORDER BY table_schema, table_name
            """
        )).all()
    except Exception as e:
        return f"(schema catalog unavailable: {str(e)[:120]})"
    lines = [f"{s}.{t}({c})" for s, t, c in rows]
    txt = "\n".join(lines)
    _SCHEMA_CACHE["text"] = txt
    return txt


_RUN_SQL_TOOL = {
    "name": "run_sql",
    "description": (
        "Run a READ-ONLY PostgreSQL query against the live company database to fetch any "
        "detail not already in the SNAPSHOT — specific invoices, breakdowns by person/"
        "project/period, individual time entries, the finance schema (loans, financing, "
        "unbilled, notes), bank transactions, expenses, clients, tasks. Rules: exactly one "
        "SELECT (or WITH ... SELECT) statement, no semicolons, no writes/DDL. Always scope "
        "with WHERE/GROUP BY — never select an entire table. Returns up to 500 rows as JSON. "
        "Prefer running a query over telling the user data is missing."
    ),
    "input_schema": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "A single read-only SELECT/WITH query."}},
        "required": ["query"],
        "additionalProperties": False,
    },
}


# ---- prompt -----------------------------------------------------------------

_SYSTEM = """You are the internal financial & operations analyst for Aquatech Engineering P.C., a small consulting engineering firm. You answer the owner's questions about the company — finances, accounts, employees, clients, projects, payroll, receivables, cash, hours — using the COMPANY DATA SNAPSHOT below and the `run_sql` tool for anything the snapshot doesn't already contain.

How to answer:
- Check the SNAPSHOT first for headline/roll-up figures. For ANY detail it doesn't fully contain — specific invoices, per-person / per-project / per-period breakdowns, individual time entries, the finance schema, expenses, transactions, clients, tasks — call `run_sql` to fetch it. Almost everything is queryable; prefer querying over saying data is missing. You may call `run_sql` several times to drill down.
- Ground every claim in snapshot values or query results. Cite exact numbers. Never invent figures.
- Money is USD, format $12,345 (cents only when they matter). Percentages to one decimal.

KEY DATA SEMANTICS (use these to write correct SQL):
- time_entries: hours, is_billable (per-entry flag), billed (TRUE once invoiced — app-authoritative), source ('manual' now, 'freshbooks_api' legacy), bill_rate_applied, cost_rate_applied, work_date, project_id, user_id, task_id, subtask_id. UNBILLED BILLABLE work = (is_billable AND NOT billed). Labor cost = hours*cost_rate_applied (all labor is COGS).
- projects: id, name (e.g. 'LTCP4', 'BWT 1608-Jobcon', 'Aquatech Operations'), is_billable, is_overhead. 'Aquatech Operations' / overhead = non-billable cost, not revenue.
- users: full_name, role, is_active. Join time_entries.user_id = users.id.
- invoices: invoice_number, client_name, status (draft|sent|partial|paid|overdue|void|written_off), subtotal_amount, amount_paid, balance_due, start_date, end_date, issue_date, due_date, project_id. Outstanding AR = status NOT IN ('void','draft','paid','written_off') AND balance_due > 0.
- finance schema (curated views/tables): v_summary, v_money_owed, v_outstanding_net, v_project_economics, v_labor, v_labor_by_project, v_labor_by_person, v_labor_by_month; tables boc_loans, invoice_financing, unbilled, notes, staff_rates. Use these for money owed, BOC advances, and project economics.
- LTCP4 bills on 4-WEEK periods, not calendar months. Today is {as_of}.

FINAL OUTPUT — after any tool use, your FINAL message must be ONLY a single JSON object (no prose around it, no code fences) with EXACTLY this shape:
{"answer": "<GitHub-flavored markdown>", "key_numbers": [{"label": "...", "value": "..."}], "charts": [], "answerability": {"status": "answered", "missing_data": "", "suggested_source": ""}}
- charts: array of 0-3 chart objects, each {"type":"bar|line|pie","title":"...","unit":"$|hrs|%","labels":["..."],"series":[{"name":"...","data":[<numbers>]}]}. Leave [] unless a chart genuinely helps.
- answerability.status: "answered" when you fully answered (set missing_data & suggested_source to ""). Use "partial"/"unanswered" ONLY for genuine data gaps you could not get even via SQL — then set missing_data to the specific absent data and suggested_source to a concrete thing the app should track. An off-topic question (not about the company) is NOT a data gap.
- {mode_instructions}

DATABASE SCHEMA (schema.table(columns)):
{schema}

COMPANY DATA SNAPSHOT (JSON, current as of {as_of}):
{context}
"""

_QUICK = (
    "QUICK MODE: Be concise — 1-3 sentences or a single number with brief context. Put at most "
    "the 1-2 most relevant figures in key_numbers. Leave charts empty unless explicitly asked to "
    "visualize. Still use run_sql when the snapshot lacks the detail — a short answer must still be correct."
)
_DETAILED = (
    "DETAILED MODE: Be thorough. Use markdown with short sections, tables, and bullets where helpful. "
    "Populate key_numbers with 3-6 headline figures. Include 1-3 charts when a visual genuinely aids a "
    "quantitative answer (bar=comparison, line=trend, pie=composition). Query as much detail as needed."
)


def is_configured(settings) -> bool:
    return bool(getattr(settings, "ANTHROPIC_API_KEY", "") or "")


# ---- final-answer parsing ---------------------------------------------------

def _extract_json(text: str) -> dict | None:
    """Pull the final JSON object out of the model's last text block, tolerating code
    fences or minor leading/trailing prose."""
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = re.sub(r"^(json)?\s*", "", s, flags=re.IGNORECASE)
    try:
        return json.loads(s)
    except Exception:
        pass
    # fall back to the outermost {...}
    i, j = s.find("{"), s.rfind("}")
    if 0 <= i < j:
        try:
            return json.loads(s[i:j + 1])
        except Exception:
            return None
    return None


def _normalize(data: dict, mode: str, model: str, usage: dict | None) -> dict:
    data.setdefault("answer", "")
    data.setdefault("key_numbers", [])
    data.setdefault("charts", [])
    a = data.get("answerability")
    a = a if isinstance(a, dict) else {}
    data["answerability"] = {
        "status": a.get("status") if a.get("status") in ("answered", "partial", "unanswered") else "answered",
        "missing_data": (a.get("missing_data") or "").strip()[:600],
        "suggested_source": (a.get("suggested_source") or "").strip()[:600],
    }
    data["mode"] = mode
    data["model"] = model
    if usage:
        data["tokens"] = usage
    return data


# ---- main entry -------------------------------------------------------------

def ask(question: str, mode: str, db, settings) -> dict:
    """Answer a natural-language question about the company. Claude may query the DB
    read-only via the run_sql tool. Returns a dict with answer/key_numbers/charts/
    answerability, or {error, message} on failure."""
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

    as_of = datetime.date.today().isoformat()
    context = build_company_context(db)
    schema = _schema_catalog(db)
    system = (
        _SYSTEM
        .replace("{mode_instructions}", _DETAILED if mode == "detailed" else _QUICK)
        .replace("{schema}", schema)
        .replace("{context}", json.dumps(context, default=_json_default, ensure_ascii=False))
        .replace("{as_of}", as_of)
    )
    model = getattr(settings, "ASSISTANT_MODEL", "claude-opus-4-8") or "claude-opus-4-8"

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 8000 if mode == "detailed" else 2000,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "tools": [_RUN_SQL_TOOL],
    }
    if mode == "detailed":
        kwargs["thinking"] = {"type": "adaptive"}
    else:
        kwargs["thinking"] = {"type": "disabled"}

    max_turns = 8 if mode == "detailed" else 5
    max_sql = 16
    sql_calls = 0
    messages: list[dict[str, Any]] = [{"role": "user", "content": question.strip()[:2000]}]

    try:
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        last = None
        tot_in = tot_out = 0
        for _turn in range(max_turns):
            resp = client.messages.create(messages=messages, **kwargs)
            last = resp
            try:
                tot_in += resp.usage.input_tokens
                tot_out += resp.usage.output_tokens
            except Exception:
                pass
            if getattr(resp, "stop_reason", None) == "refusal":
                return {"error": "refusal", "message": "The assistant declined to answer that question."}
            if getattr(resp, "stop_reason", None) != "tool_use":
                break
            # run the requested tool calls, feed results back
            messages.append({"role": "assistant", "content": resp.content})
            results = []
            for block in resp.content:
                if getattr(block, "type", None) == "tool_use" and block.name == "run_sql":
                    if sql_calls >= max_sql:
                        out = {"error": "query budget exhausted for this question"}
                    else:
                        sql_calls += 1
                        out = _run_readonly_sql(db, (block.input or {}).get("query", ""))
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(out, default=_json_default)[:24000],
                    })
            if not results:
                break
            messages.append({"role": "user", "content": results})
        else:
            # ran out of turns — ask for a final answer with no more tools
            final_kwargs = dict(kwargs)
            final_kwargs.pop("tools", None)
            messages.append({"role": "user", "content":
                             "Stop querying and give your final JSON answer now with what you have."})
            last = client.messages.create(messages=messages, **final_kwargs)
    except anthropic.AuthenticationError:
        return {"error": "auth", "message": "The ANTHROPIC_API_KEY was rejected (invalid or revoked)."}
    except anthropic.RateLimitError:
        return {"error": "rate_limit", "message": "Rate limited by the Claude API. Try again in a moment."}
    except Exception as e:
        return {"error": "api", "message": f"Claude API error: {str(e)[:300]}"}

    text = next((b.text for b in getattr(last, "content", []) if getattr(b, "type", None) == "text"), None)
    if not text:
        return {"error": "empty", "message": "The assistant returned an empty response."}
    usage = {"in": tot_in, "out": tot_out, "sql_queries": sql_calls}
    data = _extract_json(text)
    if not isinstance(data, dict):
        # structured parse failed — still return the prose so the UI isn't empty
        return _normalize({"answer": text}, mode, model, usage)
    return _normalize(data, mode, model, usage)
