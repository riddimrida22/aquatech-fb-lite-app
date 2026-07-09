from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .settings import get_settings


class Base(DeclarativeBase):
    pass


def _create_engine():
    settings = get_settings()
    if settings.DATABASE_URL.startswith("sqlite"):
        return create_engine(
            settings.DATABASE_URL,
            connect_args={"check_same_thread": False},
            pool_pre_ping=True,
        )
    return create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_size=20,
        max_overflow=40,
        pool_timeout=60,
        pool_recycle=1800,
        pool_use_lifo=True,
        connect_args={
            "options": "-c idle_in_transaction_session_timeout=15000 -c statement_timeout=30000",
        },
    )


engine = _create_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_project_columns()
    _ensure_user_columns()
    _ensure_task_columns()
    _ensure_invoice_columns()
    _ensure_invoice_line_columns()
    _ensure_bank_columns()
    _ensure_assistant_columns()
    _ensure_dedup_indexes()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _ensure_project_columns() -> None:
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("projects")}
    statements: list[str] = []
    if "overall_budget_fee" not in cols:
        statements.append("ALTER TABLE projects ADD COLUMN overall_budget_fee DOUBLE PRECISION DEFAULT 0")
    if "target_gross_margin_pct" not in cols:
        statements.append("ALTER TABLE projects ADD COLUMN target_gross_margin_pct DOUBLE PRECISION DEFAULT 0")
    if "start_date" not in cols:
        statements.append("ALTER TABLE projects ADD COLUMN start_date DATE")
    if "end_date" not in cols:
        statements.append("ALTER TABLE projects ADD COLUMN end_date DATE")
    if "is_billable" not in cols:
        statements.append("ALTER TABLE projects ADD COLUMN is_billable BOOLEAN DEFAULT TRUE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))
        if "is_billable" not in cols:
            conn.execute(text("UPDATE projects SET is_billable = CASE WHEN is_overhead THEN FALSE ELSE TRUE END WHERE is_billable IS NULL"))


def _ensure_assistant_columns() -> None:
    insp = inspect(engine)
    if not insp.has_table("assistant_queries"):
        return
    cols = {c["name"] for c in insp.get_columns("assistant_queries")}
    statements: list[str] = []
    if "answer_full" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN answer_full TEXT")
    if "answerability" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN answerability VARCHAR(16) DEFAULT 'answered'")
    if "missing_data" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN missing_data TEXT")
    if "suggested_source" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN suggested_source TEXT")
    if "resolved" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN resolved BOOLEAN DEFAULT FALSE")
    if "resolved_at" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN resolved_at TIMESTAMP")
    if "resolved_note" not in cols:
        statements.append("ALTER TABLE assistant_queries ADD COLUMN resolved_note TEXT")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _ensure_user_columns() -> None:
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("users")}
    statements: list[str] = []
    if "start_date" not in cols:
        statements.append("ALTER TABLE users ADD COLUMN start_date DATE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _ensure_task_columns() -> None:
    insp = inspect(engine)
    if not insp.has_table("tasks"):
        return
    cols = {c["name"] for c in insp.get_columns("tasks")}
    statements: list[str] = []
    if "is_billable" not in cols:
        statements.append("ALTER TABLE tasks ADD COLUMN is_billable BOOLEAN DEFAULT TRUE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _ensure_invoice_columns() -> None:
    insp = inspect(engine)
    if not insp.has_table("invoices"):
        return
    cols = {c["name"] for c in insp.get_columns("invoices")}
    statements: list[str] = []
    if "source" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN source VARCHAR(32) DEFAULT 'app'")
    if "amount_paid" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN amount_paid DOUBLE PRECISION DEFAULT 0")
    if "balance_due" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN balance_due DOUBLE PRECISION DEFAULT 0")
    if "paid_date" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN paid_date DATE")
    if "recurring_schedule_id" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN recurring_schedule_id INTEGER")
    if "recurring_run_date" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN recurring_run_date DATE")
    if "payment_link_token" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN payment_link_token VARCHAR(96)")
    if "payment_link_enabled" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN payment_link_enabled BOOLEAN DEFAULT FALSE")
    if "payment_link_expires_at" not in cols:
        statements.append("ALTER TABLE invoices ADD COLUMN payment_link_expires_at DATE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _ensure_invoice_line_columns() -> None:
    insp = inspect(engine)
    if not insp.has_table("invoice_lines"):
        return
    cols = {c["name"] for c in insp.get_columns("invoice_lines")}
    statements: list[str] = []
    if "note" not in cols:
        statements.append("ALTER TABLE invoice_lines ADD COLUMN note TEXT DEFAULT ''")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))


def _ensure_dedup_indexes() -> None:
    """Backstop the Python upserts with DB-level uniqueness on (source, external_id).

    PARTIAL index (only where external_id is a real value) so manual/empty rows —
    which legitimately share source='manual' with NULL/'' external_id — are never
    blocked; only sync'd rows keyed by an external id must be unique. Both SQLite
    (>=3.8) and Postgres support partial unique indexes and `IF NOT EXISTS`. Verified
    2026-07-02: no existing (source, external_id) duplicates on any table, so this
    cannot fail on current data. Each wrapped independently so one issue can't block
    startup.
    """
    insp = inspect(engine)
    targets = {
        "time_entries": "uq_time_entries_source_extid",
        "invoices": "uq_invoices_source_extid",
        "project_expenses": "uq_project_expenses_source_extid",
    }
    for table, idx in targets.items():
        if not insp.has_table(table):
            continue
        cols = {c["name"] for c in insp.get_columns(table)}
        if not {"source", "external_id"}.issubset(cols):
            continue
        stmt = (
            f"CREATE UNIQUE INDEX IF NOT EXISTS {idx} ON {table} (source, external_id) "
            f"WHERE external_id IS NOT NULL AND external_id <> ''"
        )
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
        except Exception as exc:  # pragma: no cover - defensive; never block startup
            print(f"[dedup-index] WARNING: could not create {idx} on {table}: {str(exc)[:160]}")


def _ensure_bank_columns() -> None:
    insp = inspect(engine)
    statements: list[str] = []
    if insp.has_table("bank_accounts"):
        account_cols = {c["name"] for c in insp.get_columns("bank_accounts")}
        if "is_business" not in account_cols:
            statements.append("ALTER TABLE bank_accounts ADD COLUMN is_business BOOLEAN DEFAULT TRUE")
    if insp.has_table("bank_transactions"):
        tx_cols = {c["name"] for c in insp.get_columns("bank_transactions")}
        if "is_business" not in tx_cols:
            statements.append("ALTER TABLE bank_transactions ADD COLUMN is_business BOOLEAN DEFAULT TRUE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))
        if insp.has_table("bank_accounts"):
            conn.execute(text("UPDATE bank_accounts SET is_business = TRUE WHERE is_business IS NULL"))
        if insp.has_table("bank_transactions"):
            conn.execute(text("UPDATE bank_transactions SET is_business = TRUE WHERE is_business IS NULL"))
