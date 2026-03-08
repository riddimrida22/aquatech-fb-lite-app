import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

DB_FILE = Path("/tmp/aquatech_financial_test.db")
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


def test_freshbooks_invoice_import_and_ar_rollup() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.fin@aquatechpc.com", "full_name": "Finance Admin"},
        )
        assert bootstrap.status_code == 200

        csv_content = "\n".join(
            [
                "Invoice #,Client,Invoice Date,Due Date,Status,Total,Paid,Balance",
                "INV-1001,Acme Co,2026-01-05,2026-01-20,Sent,1000,200,800",
                "INV-1002,Beta LLC,2026-01-10,2026-03-15,Sent,500,0,500",
            ]
        )
        files = {"file": ("freshbooks_invoices.csv", csv_content, "text/csv")}

        preview = client.post("/invoices/import/freshbooks?apply=false", files=files)
        assert preview.status_code == 200
        preview_json = preview.json()
        assert preview_json["count"] == 2
        assert preview_json["errors"] == 0
        assert preview_json["imported"] == 0

        applied = client.post("/invoices/import/freshbooks?apply=true", files=files)
        assert applied.status_code == 200
        applied_json = applied.json()
        assert applied_json["count"] == 2
        assert applied_json["imported"] == 2
        assert applied_json["updated"] == 0
        assert applied_json["errors"] == 0

        ar = client.get("/reports/ar-summary")
        assert ar.status_code == 200
        ar_json = ar.json()
        assert ar_json["invoice_count_open"] == 2
        assert ar_json["total_outstanding"] == 1300
        assert ar_json["overdue_invoice_count"] >= 1

        invoices_res = client.get("/invoices")
        assert invoices_res.status_code == 200
        invoices = invoices_res.json()
        invoice_1001 = next((inv for inv in invoices if inv["invoice_number"] == "INV-1001"), None)
        assert invoice_1001 is not None

        pay_update = client.put(
            f"/invoices/{invoice_1001['id']}/payment",
            json={"amount_paid": 1000, "paid_date": "2026-02-15"},
        )
        assert pay_update.status_code == 200
        updated = pay_update.json()
        assert updated["status"] == "paid"
        assert updated["balance_due"] == 0

        ar_after = client.get("/reports/ar-summary")
        assert ar_after.status_code == 200
        ar_after_json = ar_after.json()
        assert ar_after_json["invoice_count_open"] == 1
        assert ar_after_json["total_outstanding"] == 500
        assert ar_after_json["overdue_invoice_count"] == 0


def test_import_uses_payment_amounts_and_ignores_drafts_for_ar() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.pay@aquatechpc.com", "full_name": "Payment Admin"},
        )
        assert bootstrap.status_code == 200

        csv_content = "\n".join(
            [
                "Invoice #,Client,Invoice Date,Due Date,Status,Total,Paid,Balance",
                "INV-2001,Client A,2026-01-05,2026-01-20,draft,1000,1000,0",
                "INV-2002,Client B,2026-01-05,2026-01-20,draft,1000,200,800",
                "INV-2003,Client C,2026-01-05,2026-01-20,draft,500,0,500",
            ]
        )
        files = {"file": ("freshbooks_invoices.csv", csv_content, "text/csv")}
        applied = client.post("/invoices/import/freshbooks?apply=true", files=files)
        assert applied.status_code == 200
        payload = applied.json()
        assert payload["imported"] == 3
        assert payload["errors"] == 0

        invoices_res = client.get("/invoices")
        assert invoices_res.status_code == 200
        invoices = {inv["invoice_number"]: inv for inv in invoices_res.json()}
        assert invoices["INV-2001"]["status"] == "paid"
        assert invoices["INV-2001"]["balance_due"] == 0
        assert invoices["INV-2002"]["status"] == "partial"
        assert invoices["INV-2002"]["balance_due"] == 800
        assert invoices["INV-2003"]["status"] == "draft"

        ar = client.get("/reports/ar-summary")
        assert ar.status_code == 200
        ar_json = ar.json()
        assert ar_json["invoice_count_open"] == 1
        assert ar_json["total_outstanding"] == 800


def test_unbilled_since_last_invoice_ignores_draft_invoices() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.unbilled@aquatechpc.com", "full_name": "Unbilled Admin"},
        )
        assert bootstrap.status_code == 200
        admin_id = bootstrap.json()["id"]

        project = client.post(
            "/projects",
            json={
                "name": "Billing Project",
                "client_name": "Billing Client",
                "pm_user_id": admin_id,
                "start_date": "2026-01-01",
                "end_date": "2026-12-31",
                "overall_budget_fee": 10000,
                "is_overhead": False,
            },
        )
        assert project.status_code == 200
        project_id = project.json()["id"]

        task = client.post(f"/projects/{project_id}/tasks", json={"name": "Design"})
        assert task.status_code == 200
        task_id = task.json()["id"]

        subtask = client.post(
            f"/tasks/{task_id}/subtasks",
            json={"code": "DES-01", "name": "Model", "budget_hours": 20, "budget_fee": 2000},
        )
        assert subtask.status_code == 200
        subtask_id = subtask.json()["id"]

        set_rate = client.post(
            "/rates",
            json={"user_id": admin_id, "effective_date": "2026-01-01", "bill_rate": 100, "cost_rate": 50},
        )
        assert set_rate.status_code == 200

        entry_one = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-01-02",
                "hours": 1,
                "note": "phase 1",
            },
        )
        assert entry_one.status_code == 200

        create_invoice = client.post(
            "/invoices",
            json={
                "start": "2026-01-01",
                "end": "2026-01-03",
                "project_id": project_id,
                "approved_only": False,
                "issue_date": "2026-01-05",
                "due_date": "2026-01-20",
                "notes": "draft invoice",
            },
        )
        assert create_invoice.status_code == 200
        invoice_id = create_invoice.json()["id"]
        assert create_invoice.json()["status"] == "draft"

        entry_two = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-01-10",
                "hours": 2,
                "note": "phase 2",
            },
        )
        assert entry_two.status_code == 200

        unbilled_before_sent = client.get("/reports/unbilled-since-last-invoice")
        assert unbilled_before_sent.status_code == 200
        rows_before = unbilled_before_sent.json()["by_client"]
        assert rows_before and rows_before[0]["client_name"] == "Billing Client"
        assert rows_before[0]["unbilled"] == 300

        update_status = client.put(
            f"/invoices/{invoice_id}/payment",
            json={"amount_paid": 0, "status": "sent"},
        )
        assert update_status.status_code == 200
        assert update_status.json()["status"] == "sent"

        unbilled_after_sent = client.get("/reports/unbilled-since-last-invoice")
        assert unbilled_after_sent.status_code == 200
        rows_after = unbilled_after_sent.json()["by_client"]
        assert rows_after and rows_after[0]["client_name"] == "Billing Client"
        assert rows_after[0]["unbilled"] == 200


def test_unbilled_since_last_invoice_excludes_pre_cutoff_uninvoiced_time() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.cutoff@aquatechpc.com", "full_name": "Cutoff Admin"},
        )
        assert bootstrap.status_code == 200
        admin_id = bootstrap.json()["id"]

        project = client.post(
            "/projects",
            json={
                "name": "Cutoff Project",
                "client_name": "Cutoff Client",
                "pm_user_id": admin_id,
                "start_date": "2026-01-01",
                "end_date": "2026-12-31",
                "overall_budget_fee": 10000,
                "is_overhead": False,
            },
        )
        assert project.status_code == 200
        project_id = project.json()["id"]

        task = client.post(f"/projects/{project_id}/tasks", json={"name": "Design"})
        assert task.status_code == 200
        task_id = task.json()["id"]

        subtask = client.post(
            f"/tasks/{task_id}/subtasks",
            json={"code": "DES-01", "name": "Model", "budget_hours": 20, "budget_fee": 2000},
        )
        assert subtask.status_code == 200
        subtask_id = subtask.json()["id"]

        set_rate = client.post(
            "/rates",
            json={"user_id": admin_id, "effective_date": "2026-01-01", "bill_rate": 100, "cost_rate": 50},
        )
        assert set_rate.status_code == 200

        pre_cutoff_uninvoiced = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-01-04",
                "hours": 1,
                "note": "before cutoff but uninvoiced",
            },
        )
        assert pre_cutoff_uninvoiced.status_code == 200

        invoiced_entry = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-01-06",
                "hours": 2,
                "note": "to be invoiced",
            },
        )
        assert invoiced_entry.status_code == 200

        post_cutoff_uninvoiced = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-01-10",
                "hours": 3,
                "note": "after cutoff and uninvoiced",
            },
        )
        assert post_cutoff_uninvoiced.status_code == 200

        create_invoice = client.post(
            "/invoices",
            json={
                "start": "2026-01-05",
                "end": "2026-01-07",
                "project_id": project_id,
                "approved_only": False,
                "issue_date": "2026-01-08",
                "due_date": "2026-01-22",
                "notes": "cutoff invoice",
            },
        )
        assert create_invoice.status_code == 200
        invoice_id = create_invoice.json()["id"]

        mark_sent = client.put(
            f"/invoices/{invoice_id}/payment",
            json={"amount_paid": 0, "status": "sent"},
        )
        assert mark_sent.status_code == 200
        assert mark_sent.json()["status"] == "sent"

        unbilled = client.get("/reports/unbilled-since-last-invoice")
        assert unbilled.status_code == 200
        rows = unbilled.json()["by_client"]
        assert rows and rows[0]["client_name"] == "Cutoff Client"
        assert rows[0]["unbilled"] == 300


def test_unbilled_since_last_invoice_uses_completed_timesheet_weeks() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.workflow@aquatechpc.com", "full_name": "Workflow Admin"},
        )
        assert bootstrap.status_code == 200
        admin_id = bootstrap.json()["id"]

        project = client.post(
            "/projects",
            json={
                "name": "Workflow Project",
                "client_name": "Workflow Client",
                "pm_user_id": admin_id,
                "start_date": "2026-01-01",
                "end_date": "2026-12-31",
                "overall_budget_fee": 10000,
                "is_overhead": False,
            },
        )
        assert project.status_code == 200
        project_id = project.json()["id"]

        task = client.post(f"/projects/{project_id}/tasks", json={"name": "Execution"})
        assert task.status_code == 200
        task_id = task.json()["id"]

        subtask = client.post(
            f"/tasks/{task_id}/subtasks",
            json={"code": "EX-01", "name": "Field Work", "budget_hours": 20, "budget_fee": 2000},
        )
        assert subtask.status_code == 200
        subtask_id = subtask.json()["id"]

        set_rate = client.post(
            "/rates",
            json={"user_id": admin_id, "effective_date": "2026-01-01", "bill_rate": 100, "cost_rate": 50},
        )
        assert set_rate.status_code == 200

        approved_week_entry = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-02-03",
                "hours": 2,
                "note": "approved week entry",
            },
        )
        assert approved_week_entry.status_code == 200

        draft_week_entry = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-02-10",
                "hours": 3,
                "note": "draft week entry",
            },
        )
        assert draft_week_entry.status_code == 200

        ts_approved_week = client.post("/timesheets/generate?week_start=2026-02-02")
        assert ts_approved_week.status_code == 200
        ts_approved_week_id = ts_approved_week.json()["id"]

        submit = client.post(f"/timesheets/{ts_approved_week_id}/submit")
        assert submit.status_code == 200
        approve = client.post(f"/timesheets/{ts_approved_week_id}/approve")
        assert approve.status_code == 200

        ts_draft_week = client.post("/timesheets/generate?week_start=2026-02-09")
        assert ts_draft_week.status_code == 200
        ts_draft_week_id = ts_draft_week.json()["id"]
        if ts_draft_week.json()["status"] in {"submitted", "approved"}:
            returned = client.post(f"/timesheets/{ts_draft_week_id}/return")
            assert returned.status_code == 200
            assert returned.json()["status"] == "rejected"

        unbilled = client.get("/reports/unbilled-since-last-invoice")
        assert unbilled.status_code == 200
        rows = unbilled.json()["by_client"]
        assert rows and rows[0]["client_name"] == "Workflow Client"
        assert rows[0]["unbilled"] == 200


def test_reconcile_imported_and_legacy_client_labels() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.reconcile@aquatechpc.com", "full_name": "Reconcile Admin"},
        )
        assert bootstrap.status_code == 200
        admin_id = bootstrap.json()["id"]

        project = client.post(
            "/projects",
            json={
                "name": "Legacy Billing Project",
                "client_name": "Legacy Client",
                "pm_user_id": admin_id,
                "start_date": "2026-01-01",
                "end_date": "2026-12-31",
                "overall_budget_fee": 10000,
                "is_overhead": False,
            },
        )
        assert project.status_code == 200
        project_id = project.json()["id"]

        task = client.post(f"/projects/{project_id}/tasks", json={"name": "Design"})
        assert task.status_code == 200
        task_id = task.json()["id"]

        subtask = client.post(
            f"/tasks/{task_id}/subtasks",
            json={"code": "DES-01", "name": "Model", "budget_hours": 20, "budget_fee": 2000},
        )
        assert subtask.status_code == 200
        subtask_id = subtask.json()["id"]

        set_rate = client.post(
            "/rates",
            json={"user_id": admin_id, "effective_date": "2026-01-01", "bill_rate": 100, "cost_rate": 50},
        )
        assert set_rate.status_code == 200

        entry = client.post(
            "/time-entries",
            json={
                "project_id": project_id,
                "task_id": task_id,
                "subtask_id": subtask_id,
                "work_date": "2026-01-06",
                "hours": 2,
                "note": "legacy labeled client invoice",
            },
        )
        assert entry.status_code == 200

        create_invoice = client.post(
            "/invoices",
            json={
                "start": "2026-01-05",
                "end": "2026-01-07",
                "project_id": project_id,
                "approved_only": False,
                "issue_date": "2026-01-08",
                "due_date": "2026-01-22",
                "notes": "legacy client invoice",
            },
        )
        assert create_invoice.status_code == 200
        assert create_invoice.json()["client_name"] == "Legacy Client"

        imported_csv = "\n".join(
            [
                "Invoice #,Client,Invoice Date,Due Date,Status,Total,Paid,Balance",
                "INV-LGC-1,Imported Client,2026-01-10,2026-01-20,Sent,500,0,500",
            ]
        )
        files = {"file": ("freshbooks_invoices.csv", imported_csv, "text/csv")}
        import_res = client.post("/invoices/import/freshbooks?apply=true", files=files)
        assert import_res.status_code == 200

        reconcile = client.post(
            "/invoices/reconcile-client-labels",
            json={
                "canonical_client_name": "Actual Client LLC",
                "aliases": ["Imported Client", "Legacy Client"],
            },
        )
        assert reconcile.status_code == 200
        payload = reconcile.json()
        assert payload["canonical_client_name"] == "Actual Client LLC"
        assert payload["invoices_updated"] >= 1
        assert payload["projects_updated"] >= 1

        invoices = client.get("/invoices")
        assert invoices.status_code == 200
        client_names = {inv["client_name"] for inv in invoices.json()}
        assert "Imported Client" not in client_names
        assert "Legacy Client" not in client_names
        assert "Actual Client LLC" in client_names

        projects = client.get("/projects")
        assert projects.status_code == 200
        project_clients = {p["client_name"] for p in projects.json()}
        assert "Legacy Client" not in project_clients
        assert "Actual Client LLC" in project_clients


def test_freshbooks_line_item_export_aggregates_to_single_invoice_total() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.lineitems@aquatechpc.com", "full_name": "Line Item Admin"},
        )
        assert bootstrap.status_code == 200

        line_item_csv = "\n".join(
            [
                "Client Name,Invoice #,Date Issued,Date Due,Invoice Status,Item Name,Line Total,Currency",
                "HDR,HDRAQ-014,2026-02-24,2026-04-25,Sent,Task A,10000.00,USD",
                "HDR,HDRAQ-014,2026-02-24,2026-04-25,Sent,Task B,12212.15,USD",
                "HDR,HDRAQ-014,2026-02-24,2026-04-25,Sent,Task C,10000.00,USD",
            ]
        )
        files = {"file": ("freshbooks_line_items.csv", line_item_csv, "text/csv")}
        preview = client.post("/invoices/import/freshbooks?apply=false", files=files)
        assert preview.status_code == 200
        preview_json = preview.json()
        assert preview_json["count"] == 1
        assert preview_json["line_item_mode"] is True

        applied = client.post("/invoices/import/freshbooks?apply=true", files=files)
        assert applied.status_code == 200
        payload = applied.json()
        assert payload["count"] == 1
        assert payload["imported"] == 1
        assert payload["errors"] == 0

        invoices_res = client.get("/invoices")
        assert invoices_res.status_code == 200
        invoices = {inv["invoice_number"]: inv for inv in invoices_res.json()}
        assert "HDRAQ-014" in invoices
        assert invoices["HDRAQ-014"]["subtotal_amount"] == 32212.15
        assert invoices["HDRAQ-014"]["status"] == "sent"


def test_freshbooks_payments_import_updates_paid_and_balance() -> None:
    with TestClient(app) as client:
        bootstrap = client.post(
            "/auth/dev/bootstrap-admin",
            json={"email": "admin.payimport@aquatechpc.com", "full_name": "Payments Import Admin"},
        )
        assert bootstrap.status_code == 200

        invoices_csv = "\n".join(
            [
                "Invoice #,Client,Invoice Date,Due Date,Status,Total,Paid,Balance",
                "INV-PAY-1,HDR,2026-02-24,2026-03-25,Sent,1000,0,1000",
            ]
        )
        apply_invoices = client.post(
            "/invoices/import/freshbooks?apply=true",
            files={"file": ("freshbooks_invoices.csv", invoices_csv, "text/csv")},
        )
        assert apply_invoices.status_code == 200

        payments_csv = "\n".join(
            [
                "Date,Client Name,Method,Description,Payment for,Number,Amount,Currency",
                "2026-03-01,HDR,ACH,,Invoice,INV-PAY-1,400.00,USD",
                "2026-03-05,HDR,ACH,,Invoice,INV-PAY-1,600.00,USD",
            ]
        )
        preview = client.post(
            "/invoices/import/freshbooks-payments?apply=false",
            files={"file": ("payments_collected.csv", payments_csv, "text/csv")},
        )
        assert preview.status_code == 200
        preview_json = preview.json()
        assert preview_json["count"] == 1
        assert preview_json["matched"] == 1
        assert preview_json["unmatched"] == 0

        applied = client.post(
            "/invoices/import/freshbooks-payments?apply=true",
            files={"file": ("payments_collected.csv", payments_csv, "text/csv")},
        )
        assert applied.status_code == 200
        applied_json = applied.json()
        assert applied_json["updated"] == 1
        assert applied_json["matched"] == 1
        assert applied_json["unmatched"] == 0

        invoices_res = client.get("/invoices")
        assert invoices_res.status_code == 200
        invoice = next((inv for inv in invoices_res.json() if inv["invoice_number"] == "INV-PAY-1"), None)
        assert invoice is not None
        assert invoice["amount_paid"] == 1000
        assert invoice["balance_due"] == 0
        assert invoice["status"] == "paid"
