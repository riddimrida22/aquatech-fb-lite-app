#!/usr/bin/env python
"""Seed pursuits from the real 'Aquatech Book of Work.xlsx' pipeline, with their
actual win/loss outcomes and illustrative go/no-go scores — so the Phase-2
calibration (win rate by score band, factor lift) has history to learn from.

Scores are illustrative: winners are biased higher and losers lower, with noise
and overlap, so the calibration curve is realistic rather than perfect.

  DATABASE_URL="sqlite:///./bd_local.db" python seed_bd_pursuits.py            # dry-run
  DATABASE_URL="sqlite:///./bd_local.db" python seed_bd_pursuits.py --commit
"""
from __future__ import annotations

import json
import os
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import openpyxl
from sqlalchemy import func, select

import app.models  # register tables
from app import db as _db
from app.models import Pursuit

BOW = os.environ.get(
    "BD_BOOK_OF_WORK",
    r"G:\Shared drives\Aquatech_Admin\Business_Development\Business Development Planning\Aquatech Book of Work.xlsx",
)
COMMIT = "--commit" in sys.argv
random.seed(42)

# same rubric as main.py (_GNG_FACTORS)
FACTORS = [("strategic_fit", 0.15), ("client_relationship", 0.15), ("competitive_position", 0.15),
           ("profitability", 0.10), ("staff_capacity", 0.10), ("past_performance", 0.10),
           ("teaming", 0.08), ("contract_risk", 0.07), ("pursuit_cost", 0.05), ("schedule", 0.05)]

AGENCY = {"dep": "NYC DEP", "nycha": "NYCHA", "panynj": "PANYNJ", "port authority": "PANYNJ",
          "dot": "DOT", "nypa": "NYPA", "stantec": "Stantec", "carollo": "Carollo",
          "w&c": "W&C", "cmvny": "City of Mount Vernon", "office of mental health": "NYS OMH"}


def stage_from(raw: str):
    """Map the Book-of-Work stage column to (stage, is_open)."""
    t = (raw or "").lower()
    if "in contract" in t or "completed" in t:
        return "won", False
    if "no go" in t:
        return "lost", False           # we pitched and didn't land it
    if "pitched-positive" in t or "pitched - positive" in t:
        return "proposal", True
    if "neutral" in t:
        return "qualifying", True
    return None, None


def sector_from(text: str):
    t = (text or "").lower()
    for k, s in [("sewer", "water"), ("cso", "water"), ("water", "water"), ("ltcp", "water"),
                 ("traffic", "transportation"), ("tunnel", "transportation"), ("bridge", "transportation"),
                 ("energy", "energy"), ("environmental", "environmental"), ("inspection", "buildings")]:
        if k in t:
            return s
    return None


def scores_for(outcome: str) -> dict:
    """Illustrative 1..5 scores: winners biased high, losers low, with noise+overlap."""
    if outcome == "won":
        center = 4.0
    elif outcome == "lost":
        center = 2.4
    else:
        center = 3.1
    out = {}
    for key, _w in FACTORS:
        v = round(random.gauss(center, 0.9))
        out[key] = max(1, min(5, v))
    return out


def gng_value(scores: dict) -> float:
    return round(sum(w * (scores[k] / 5.0) * 100.0 for k, w in FACTORS), 1)


def rows():
    wb = openpyxl.load_workbook(BOW, data_only=True, read_only=True)
    ws = wb["Book of Work"]
    for i, r in enumerate(ws.iter_rows(values_only=True)):
        if i < 4:
            continue
        c = [("" if x is None else str(x).strip()) for x in (list(r) + [""] * 11)]
        name = c[4]
        if not name or len(name) < 4:
            continue
        stage, is_open = stage_from(c[2])
        if not stage:
            continue
        client = c[5] or "Unknown"
        agency = next((v for k, v in AGENCY.items() if k in (client + " " + name).lower()), None)
        fee = 0.0
        for cell in (c[9], c[10]):
            try:
                fee = float(str(cell).replace(",", "").replace("$", "")) or fee
            except (ValueError, TypeError):
                pass
        outcome = "won" if stage == "won" else ("lost" if stage == "lost" else "open")
        sc = scores_for(outcome)
        yield dict(name=name[:255], client_name=client[:255], agency=agency,
                   sector=sector_from(name), prime_partner=(c[6] or None),
                   stage=stage, is_open=is_open, est_fee=fee,
                   win_probability=1.0 if stage == "won" else (0.0 if stage == "lost" else 0.4),
                   source=(c[8] or "book_of_work")[:32],
                   scores=sc, gng=gng_value(sc), outcome=outcome, year=c[1])


def main():
    print(f"Book of Work : {BOW}")
    print(f"Mode         : {'COMMIT' if COMMIT else 'DRY-RUN'}\n")
    s = _db.SessionLocal() if COMMIT else None
    if COMMIT:
        _db.init_db()
    existing = set()
    if COMMIT:
        for (nm,) in s.execute(select(Pursuit.name)).all():
            existing.add(nm)
    n = 0
    tally = {"won": 0, "lost": 0, "open": 0}
    for d in rows():
        tally[d["outcome"]] += 1
        if COMMIT and d["name"] in existing:
            continue
        n += 1
        if not COMMIT:
            print(f"  [{d['stage']:10}] gng={d['gng']:5}  {d['name'][:52]:52} "
                  f"{(d['agency'] or '-'):12} fee={d['est_fee']:>9,.0f}")
            continue
        closed = date(int(d["year"]) if str(d["year"]).isdigit() else 2025, 6, 15) if not d["is_open"] else None
        s.add(Pursuit(
            name=d["name"], client_name=d["client_name"], agency=d["agency"], sector=d["sector"],
            role="prime", prime_partner=d["prime_partner"], stage=d["stage"], is_open=d["is_open"],
            win_probability=d["win_probability"], est_fee=d["est_fee"], source=d["source"],
            gng_score=d["gng"],
            gng_recommendation=("go" if d["gng"] >= 70 else "conditional" if d["gng"] >= 50 else "no_go"),
            gng_scores_json=json.dumps(d["scores"]), gng_decided_at=datetime.utcnow(),
            closed_date=closed, outcome_reason=("won" if d["outcome"] == "won" else "not selected" if d["outcome"] == "lost" else None),
            created_at=datetime.utcnow() - timedelta(days=120)))
    if COMMIT:
        s.commit(); s.close()
        print(f"COMMITTED {n} pursuits.")
    print(f"\nOutcomes: won={tally['won']} lost={tally['lost']} open={tally['open']}")


if __name__ == "__main__":
    main()
