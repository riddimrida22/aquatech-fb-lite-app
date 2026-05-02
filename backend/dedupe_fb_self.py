"""One-shot: collapse self-duplicates within the FB-Expenses-source bank rows.

The FB import endpoint hashes transaction_id from filename+row_idx+amt+description, so
re-importing the same expense from a newer FB CSV creates a 2nd row. This script keeps
the most recent row per (date, abs amount, description-prefix) and deletes the rest.
"""
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

DB = Path(__file__).parent / "aquatech.db"
con = sqlite3.connect(DB)
cur = con.cursor()

# Load all FB-Expenses-Export rows
fb_rows = []
for tid, posted, amt, name, raw, created in cur.execute(
    "SELECT id, posted_date, amount, name, raw_json, created_at FROM bank_transactions"
):
    try:
        sf = (json.loads(raw or "{}").get("source_file") or "").lower()
    except Exception:
        sf = ""
    if "freshbooks" in sf and ("expense" in sf or "expenses" in sf):
        fb_rows.append((tid, posted, amt, name or "", raw, created))

print(f"FB rows: {len(fb_rows)}")

# Group by (date, abs_amount, description prefix 80 chars)
groups: dict[tuple[str, float, str], list[tuple[int, str]]] = defaultdict(list)
for tid, posted, amt, name, raw, created in fb_rows:
    key = (str(posted or ""), round(abs(float(amt or 0)), 2), (name or "")[:80])
    groups[key].append((tid, created or ""))

deleted_ids: list[int] = []
groups_with_dupes = 0
for key, rows in groups.items():
    if len(rows) <= 1:
        continue
    groups_with_dupes += 1
    # Keep the highest tid (most recently inserted = newest import)
    rows.sort(key=lambda r: (r[1], r[0]))
    keep_id = rows[-1][0]
    for tid, _ in rows[:-1]:
        deleted_ids.append(tid)

print(f"Groups with duplicates: {groups_with_dupes}")
print(f"Rows to delete: {len(deleted_ids)}")

if deleted_ids:
    chunks = [deleted_ids[i : i + 500] for i in range(0, len(deleted_ids), 500)]
    for chunk in chunks:
        placeholders = ",".join(["?"] * len(chunk))
        cur.execute(f"DELETE FROM bank_transactions WHERE id IN ({placeholders})", chunk)
    con.commit()
    print(f"Deleted {len(deleted_ids)} self-duplicate FB rows")
else:
    print("No self-duplicates found")

# Remaining count
remaining = cur.execute("SELECT COUNT(*) FROM bank_transactions").fetchone()[0]
print(f"Remaining bank_transactions: {remaining}")
con.close()
