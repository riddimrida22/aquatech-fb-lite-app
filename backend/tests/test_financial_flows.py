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
