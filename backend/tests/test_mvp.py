import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

DB_FILE = Path("/tmp/aquatech_mvp_test.db")
if DB_FILE.exists():
    DB_FILE.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{DB_FILE}"
os.environ["SESSION_SECRET"] = "test-secret"
os.environ["ALLOWED_GOOGLE_DOMAIN"] = "aquatechpc.com"
os.environ["DEV_AUTH_BYPASS"] = "true"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:3000"

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def reset_db() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def test_health_and_pay_period() -> None:
    with TestClient(app) as client:
        health = client.get("/")
        assert health.status_code == 200
        assert health.json()["ok"] is True

        pp = client.get("/timeframes/pay-period", params={"date_str": "2026-02-02"})
        assert pp.status_code == 200
        assert pp.json() == {"start": "2026-02-02", "end": "2026-02-15"}


def test_end_to_end_timesheet_flow() -> None:
    with TestClient(app) as client:
        # First admin
        r = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin@aquatechpc.com", "full_name": "Admin"},
        )
        assert r.status_code == 200
        admin_id = r.json()["id"]

        # Employee first login creates inactive account
        inactive_login = client.post("/auth/dev/login", json={"email": "emp1@aquatechpc.com"})
        assert inactive_login.status_code == 403

        # Admin can activate
        pending = client.get("/users/pending")
        assert pending.status_code == 200
        assert len(pending.json()) == 1
        emp_id = pending.json()[0]["id"]

        activated = client.post(f"/users/{emp_id}/activate")
        assert activated.status_code == 200
        assert activated.json()["is_active"] is True

        # Project rule validation
        bad_project = client.post("/projects", json={"name": "P1", "is_overhead": False})
        assert bad_project.status_code == 400

        good_project = client.post(
            "/projects",
            json={
                "name": "P1",
                "client_name": "Client A",
                "pm_user_id": admin_id,
                "start_date": "2026-02-01",
                "end_date": "2026-12-31",
                "overall_budget_fee": 10000,
                "is_overhead": False,
            },
        )
        assert good_project.status_code == 200
        project_id = good_project.json()["id"]

        task = client.post(f"/projects/{project_id}/tasks", json={"name": "Design"})
        assert task.status_code == 200
        task_id = task.json()["id"]

        subtask = client.post(
            f"/tasks/{task_id}/subtasks",
            json={"code": "DES-01", "name": "Model", "budget_hours": 10, "budget_fee": 1000},
        )
        assert subtask.status_code == 200
        subtask_id = subtask.json()["id"]

        set_rate = client.post(
            "/rates",
            json={"user_id": emp_id, "effective_date": "2026-02-02", "bill_rate": 200, "cost_rate": 80},
        )
        assert set_rate.status_code == 200

        # Login employee and submit time
        emp_login = client.post("/auth/dev/login", json={"email": "emp1@aquatechpc.com"})
        assert emp_login.status_code == 200

        bad_mapping = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": 9999,
                "work_date": "2026-02-03",
                "hours": 4,
                "note": "bad",
            },
        )
        assert bad_mapping.status_code == 400

        entry = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-02-03",
                "hours": 8,
                "note": "worked",
            },
        )
        assert entry.status_code == 200
        assert entry.json()["bill_rate_applied"] == 200

        sheet = client.post("/timesheets/generate", params={"week_start": "2026-02-02"})
        assert sheet.status_code == 200
        sheet_id = sheet.json()["id"]

        submitted = client.post(f"/timesheets/{sheet_id}/submit")
        assert submitted.status_code == 200
        assert submitted.json()["status"] == "submitted"

        # Admin approves
        admin_login = client.post("/auth/dev/login", json={"email": "admin@aquatechpc.com"})
        assert admin_login.status_code == 200
        approved = client.post(f"/timesheets/{sheet_id}/approve")
        assert approved.status_code == 200
        assert approved.json()["status"] == "approved"


def test_accounting_import_preview() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin2@aquatechpc.com", "full_name": "Admin Two"},
        )
        assert bootstrap.status_code == 200

        content = "Date,Description,Amount\n2026-02-10,POS STARBUCKS,-12.34\n"
        files = {"file": ("bank.csv", content, "text/csv")}
        res = client.post("/accounting/import-preview?account_id=CHK-001", files=files)
        assert res.status_code == 200
        payload = res.json()
        assert payload["count"] == 1
        assert payload["rows"][0]["direction"] == "debit"
        assert payload["rows"][0]["vendor_norm"] == "STARBUCKS"
