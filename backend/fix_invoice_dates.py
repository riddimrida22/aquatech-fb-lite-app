"""One-off: re-apply Date Issued / Date Due from the FB CSV to existing invoices.

The transition import path has a bug where issue/due dates fall back to today.
Until that's fully fixed, this script syncs the dates directly from the CSV.
"""
import csv
import sqlite3
from datetime import datetime
from pathlib import Path

DB = Path(__file__).parent / "aquatech.db"
CSV = Path("C:/Users/bertr/Organized/Curated/Projects_Master/AquatechPM/data/imports/AqtPM-Uploads/FreshBooks - Invoices Export - 2023-01-01 - 2026-05-02.csv")

def parse(s: str):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None

print(f"Reading {CSV.name} ...")
agg = {}
with CSV.open("r", encoding="utf-8-sig", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        inv = (row.get("Invoice #") or "").strip()
        if not inv:
            continue
        issue = parse(row.get("Date Issued") or "")
        due = parse(row.get("Date Due") or "")
        # First valid date wins (per-invoice consistent in FB anyway)
        cur = agg.get(inv) or {}
        if issue and not cur.get("issue"):
            cur["issue"] = issue
        if due and not cur.get("due"):
            cur["due"] = due
        if cur:
            agg[inv] = cur
print(f"Parsed {len(agg)} unique invoice numbers from CSV")

print(f"Connecting to {DB} ...")
con = sqlite3.connect(DB)
cur = con.cursor()
inv_rows = cur.execute("SELECT id, invoice_number, issue_date, due_date, balance_due FROM invoices").fetchall()
print(f"DB has {len(inv_rows)} invoices total")

updates = 0
missing = 0
matched_open = 0
for row_id, inv_num, cur_issue, cur_due, balance in inv_rows:
    rec = agg.get(inv_num)
    if not rec:
        missing += 1
        continue
    new_issue = rec.get("issue") or cur_issue
    new_due = rec.get("due") or cur_due
    if new_issue == cur_issue and new_due == cur_due:
        continue
    cur.execute(
        "UPDATE invoices SET issue_date = ?, due_date = ?, start_date = ?, end_date = ? WHERE id = ?",
        (new_issue, new_due, new_issue, new_issue, row_id),
    )
    updates += 1
    if balance and balance > 0.01:
        matched_open += 1
        print(f"  updated #{inv_num}: issue {cur_issue}->{new_issue}, due {cur_due}->{new_due}, bal ${balance:.2f}")

con.commit()
con.close()
print(f"\nDone. {updates} invoices updated ({matched_open} of which are open). {missing} DB invoices not found in CSV.")
