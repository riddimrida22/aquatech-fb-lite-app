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
    return create_engine(settings.DATABASE_URL, pool_pre_ping=True)


engine = _create_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_project_columns()
    _ensure_user_columns()
    _ensure_task_columns()
    _ensure_invoice_columns()
    _ensure_invoice_line_columns()


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
    if "is_billable" not in cols:
        statements.append("ALTER TABLE projects ADD COLUMN is_billable BOOLEAN DEFAULT TRUE")
    if not statements:
        return
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))
        if "is_billable" not in cols:
            conn.execute(text("UPDATE projects SET is_billable = CASE WHEN is_overhead THEN FALSE ELSE TRUE END WHERE is_billable IS NULL"))


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
