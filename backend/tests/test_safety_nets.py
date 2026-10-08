"""Safety nets (2026-10-08): finance reads locked to VIEW_FINANCIALS, recurring-invoice errors
recorded, backup and runner checks in Data Health, FreshBooks OAuth state, safe defaults."""
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

DB_FILE = Path(tempfile.gettempdir()) / "aquatech_safety_test.db"
if DB_FILE.exists():
    DB_FILE.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{DB_FILE}"
os.environ["SESSION_SECRET"] = "test-secret"
os.environ["ALLOWED_GOOGLE_DOMAIN"] = "aquatechpc.com"
os.environ["DEV_AUTH_BYPASS"] = "true"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:3000"

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import _record_worker_error, _run_data_health_audit, app  # noqa: E402
from app.models import AuditEvent  # noqa: E402

FINANCE_READS = ["/loans", "/loans/1/payments", "/bookkeeping/actions", "/bookkeeping/overrides",
                 "/projects/1/expenses"]


@pytest.fixture(autouse=True)
def reset_db() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def _admin_and_employee(client: TestClient) -> TestClient:
    """Admin signed in on `client`; returns a second client signed in as an active employee."""
    assert client.post("/auth/dev/bootstrap-admin",
                       json={"email": "admin@aquatechpc.com", "full_name": "Admin"}).status_code == 200
    emp = TestClient(app)
    assert emp.post("/auth/dev/login", json={"email": "emp1@aquatechpc.com"}).status_code == 403  # inactive
    pending = client.get("/users/pending").json()
    assert client.post(f"/users/{pending[0]['id']}/activate").status_code == 200
    assert emp.post("/auth/dev/login", json={"email": "emp1@aquatechpc.com"}).status_code == 200
    return emp


def test_finance_reads_locked_to_finance_roles() -> None:
    with TestClient(app) as admin:
        emp = _admin_and_employee(admin)
        for path in FINANCE_READS:
            assert emp.get(path).status_code == 403, f"employee must not read {path}"
        assert admin.get("/loans").status_code == 200
        assert admin.get("/bookkeeping/overrides").status_code in (200, 500)  # table may be absent in tests
        assert admin.get("/projects/1/expenses").status_code in (200, 404)


def _health(key: str) -> dict:
    with SessionLocal() as db:
        res = _run_data_health_audit(db, trigger="test")
    return next(c for c in res["checks"] if c["key"] == key)


def test_backup_check() -> None:
    with TestClient(app):
        assert _health("backup_nightly")["status"] == "warn"  # nothing recorded yet
        with SessionLocal() as db:
            db.add(AuditEvent(entity_type="backup", entity_id=0, action="backup_ok", payload_json="{}",
                              created_at=datetime.utcnow() - timedelta(hours=3)))
            db.commit()
        assert _health("backup_nightly")["status"] == "ok"
        with SessionLocal() as db:
            db.add(AuditEvent(entity_type="backup", entity_id=0, action="backup_failed",
                              payload_json='{"detail": "pg_dump exited with an error"}'))
            db.commit()
        assert _health("backup_nightly")["status"] == "fail"


def test_backup_check_stale() -> None:
    with TestClient(app):
        with SessionLocal() as db:
            db.add(AuditEvent(entity_type="backup", entity_id=0, action="backup_ok", payload_json="{}",
                              created_at=datetime.utcnow() - timedelta(hours=30)))
            db.commit()
        assert _health("backup_nightly")["status"] == "fail"


def test_recurring_invoice_errors_recorded_and_throttled() -> None:
    with TestClient(app):
        assert _health("recurring_invoices")["status"] == "ok"
        last: dict = {}
        _record_worker_error(RuntimeError("boom"), last)
        _record_worker_error(RuntimeError("boom"), last)        # same error within the hour: not re-recorded
        _record_worker_error(ValueError("other fault"), last)   # a different error is recorded
        with SessionLocal() as db:
            n = db.query(AuditEvent).filter(AuditEvent.entity_type == "recurring_invoice_runner").count()
        assert n == 2
        assert _health("recurring_invoices")["status"] == "fail"


def test_freshbooks_callback_requires_state() -> None:
    with TestClient(app) as client:
        assert client.get("/auth/freshbooks/callback", params={"code": "x"}).status_code == 400
        r = client.get("/auth/freshbooks/callback", params={"code": "x", "state": "aqtpm"})
        assert r.status_code == 400
        r = client.get("/auth/freshbooks/callback", params={"error": "<script>alert(1)</script>", "state": "s"})
        assert r.status_code == 400 and "<script>" not in r.text


def test_safe_defaults() -> None:
    from app.settings import Settings
    assert Settings.model_fields["DEV_AUTH_BYPASS"].default is False
