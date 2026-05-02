"""Patch invoice status from FB CSV — adds overdue/viewed where backend stripped them."""
import csv
import sqlite3
from pathlib import Path

DB = Path(__file__).parent / "aquatech.db"
CSV = Path("C:/Users/bertr/Organized/Curated/Projects_Master/AquatechPM/data/imports/AqtPM-Uploads/FreshBooks - Invoices Export - 2023-01-01 - 2026-05-02.csv")


def normalize(raw: str) -> str:
    v = (raw or "").strip().lower()
    if v in {"paid", "settled", "closed"}:
        return "paid"
    if v in {"partial", "partially paid", "part-paid"}:
        return "partial"
    if v in {"void", "cancelled", "canceled"}:
        return "void"
    if v in {"draft"}:
        return "draft"
    if v in {"overdue", "past due", "past-due", "late"}:
        return "overdue"
    if v in {"viewed", "opened", "seen"}:
        return "viewed"
    return "sent"


print(f"Reading {CSV.name}…")
inv_status: dict[str, str] = {}
with CSV.open("r", encoding="utf-8-sig", newline="") as f:
    for row in csv.DictReader(f):
        inv = (row.get("Invoice #") or "").strip()
        st = (row.get("Invoice Status") or "").strip()
        if inv and st and inv not in inv_status:
            inv_status[inv] = normalize(st)
print(f"Got status for {len(inv_status)} invoices")

con = sqlite3.connect(DB)
cur = con.cursor()
updates = 0
counts = {}
for invoice_number, new_status in inv_status.items():
    cur.execute("UPDATE invoices SET status = ? WHERE invoice_number = ? AND status != ?",
                (new_status, invoice_number, new_status))
    if cur.rowcount > 0:
        updates += cur.rowcount
        counts[new_status] = counts.get(new_status, 0) + 1
con.commit()
con.close()
print(f"Updated {updates} invoices: {counts}")
