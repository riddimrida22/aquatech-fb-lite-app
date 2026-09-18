#!/usr/bin/env python
"""Seed the MARKETING DEMO vault with fictitious Pinnacle Engineering documents so
the Business Dev > Vault tab is populated for a demo. Generates tiny real PDFs (so
downloads open). Fictitious only — never load real firm data into the demo.

  DATABASE_URL="sqlite:///./demo_aquatech.db" python seed_demo_vault.py
"""
from __future__ import annotations

from datetime import date, timedelta

import fitz  # PyMuPDF (already used for pay stubs)

import app.models  # register tables
from app import db as _db
from app.models import LibraryDocument

TODAY = date.today()

# (title, category, sector, agency, discipline, tags, is_current, expires_on)
DOCS = [
    ("Dana Okafor, PE — Resume", "resume", None, None, "civil", "PE,principal", True, None),
    ("Marcus Reilly, PE — Resume", "resume", None, None, "water", "PE,senior", True, None),
    ("Priya Nair, EIT — Resume", "resume", None, None, "transportation", "EIT", True, None),
    ("Tyler Brooks — Resume", "resume", None, None, "civil", "CAD,designer", True, None),
    ("Sofia Mendes, EIT — Resume", "resume", None, None, "water", "EIT", True, None),

    ("Riverside Bridge Rehabilitation — Project Sheet", "project", "transportation", "Hudson County DOT", "bridges", "bridges", True, None),
    ("Downtown Drainage Master Plan — Project Sheet", "project", "water", "City of Fairview", "drainage", "drainage", True, None),
    ("Route 9 Corridor Traffic Study — Project Sheet", "project", "transportation", "Garden State DOT", "traffic", "traffic", True, None),
    ("Lakeside WWTP Capacity Upgrade — Project Sheet", "project", "water", "Fairview Water Authority", "wastewater", "WWTP", True, None),

    ("Pinnacle Engineering — Water & Wastewater Capabilities", "capability_statement", "water", None, None, "capabilities", True, None),
    ("Pinnacle Engineering — Transportation Capabilities", "capability_statement", "transportation", None, None, "capabilities", True, None),
    ("Pinnacle Engineering — Firm Profile & SOQ", "capability_statement", None, None, None, "SOQ,profile", True, None),

    ("MBE Certification — NYS", "certificate", None, "Empire State Development", None, "MBE", True, date(2027, 3, 15)),
    ("DBE Certification — PANYNJ", "certificate", None, "PANYNJ", None, "DBE", True, date(2027, 6, 30)),
    ("Professional Engineer License — NY", "certificate", None, "NYSED", None, "PE,license", True, date(2026, 12, 31)),
    ("Certificate of Insurance (Professional Liability)", "certificate", None, None, None, "insurance", True, TODAY + timedelta(days=41)),

    ("Hudson County DOT — Reference Letter", "client_reference", "transportation", "Hudson County DOT", None, "reference", True, None),
    ("City of Fairview — Reference Letter", "client_reference", "water", "City of Fairview", None, "reference", True, None),

    ("Riverside Bridge Rehab — Submitted Proposal", "past_proposal", "transportation", "Hudson County DOT", None, "proposal", True, None),
    ("Downtown Drainage — Submitted Proposal", "past_proposal", "water", "City of Fairview", None, "proposal", True, None),

    ("Pinnacle Engineering — 2025 Financial Statement", "financial", None, None, None, "financial", True, None),
]


def make_pdf(title: str) -> bytes:
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((60, 90), "Pinnacle Engineering P.C.", fontsize=16)
    pg.insert_text((60, 130), title, fontsize=12)
    pg.insert_text((60, 165), "Sample document for demonstration purposes.", fontsize=10, color=(0.4, 0.4, 0.4))
    b = doc.tobytes()
    doc.close()
    return b


def main():
    _db.init_db()
    s = _db.SessionLocal()
    s.query(LibraryDocument).delete()  # clean any prior demo/test docs
    for title, cat, sector, agency, disc, tags, cur, exp in DOCS:
        raw = make_pdf(title)
        s.add(LibraryDocument(
            category=cat, title=title, description="", tags=tags, status=None,
            sector=sector, agency=agency, discipline=disc, is_current=cur, expires_on=exp,
            filename=title.replace(" — ", " - ") + ".pdf", content_type="application/pdf",
            size_bytes=len(raw), content=raw))
    s.commit()
    print(f"seeded {len(DOCS)} fictitious demo vault documents")
    s.close()


if __name__ == "__main__":
    main()
