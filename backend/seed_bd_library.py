#!/usr/bin/env python
"""Seed the BD proposal-content Vault (LibraryDocument) from the shared drive.

Walks  G:\\Shared drives\\Aquatech_Admin\\Business_Development  and loads:
  * MBE_Certificates/*        -> category "certificate"
  * each pursuit folder       -> RFP docs -> "rfp"; our responses -> "past_proposal"
  * Business Development Planning/*.pdf proposals -> "past_proposal"
File bytes are stored in the DB (survive deploys, caught by the nightly backup).

SAFETY
  * Dry-run by default: prints what it WOULD insert. Add --commit to write.
  * Targets DATABASE_URL — point it at the MAIN app DB to seed for real. Do NOT
    run --commit against the marketing demo DB (keeps real filenames out of it).
  * Idempotent-ish: skips a row whose (category, filename, size) already exists.

Usage:
  DATABASE_URL="postgresql://..."  python seed_bd_library.py            # dry-run
  DATABASE_URL="postgresql://..."  python seed_bd_library.py --commit    # write
  BD_SOURCE_DIR="/g/Shared drives/Aquatech_Admin/Business_Development" python seed_bd_library.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from sqlalchemy import select

from app import db as _db
from app.models import LibraryDocument

DEFAULT_SRC = r"G:\Shared drives\Aquatech_Admin\Business_Development"
SRC = Path(os.environ.get("BD_SOURCE_DIR", DEFAULT_SRC))
COMMIT = "--commit" in sys.argv
MAX_BYTES = 30 * 1024 * 1024
DOC_EXT = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"}
CT = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# folders that are not pursuits
SKIP_DIRS = {"MBE_Certificates", "Business Development Planning", "Kensico", "Archive", ".backups",
             "Index", "RasterFunctionTemplates"}


def agency_from(text: str) -> str | None:
    t = text.lower()
    for key, agency in [
        ("panynj", "PANYNJ"), ("port authority", "PANYNJ"), ("nycha", "NYCHA"),
        ("dep", "NYC DEP"), ("ddc", "NYC DDC"), ("dot", "DOT"), ("nypa", "NYPA"),
        ("nassau", "Nassau County"), ("new rochelle", "City of New Rochelle"),
        ("skanska", "Skanska"), ("school", "NYC Public Schools"), ("nys", "New York State"),
    ]:
        if key in t:
            return agency
    return None


def is_financial(text: str) -> bool:
    t = text.lower()
    return any(k in t for k in ("balancesheet", "balance sheet", "profitloss", "profit loss",
                                "profit&loss", "rates table", "tax release", "no_emr", "no emr",
                                " w-9", "w9", "1120", "financial"))


def sector_from(text: str) -> str | None:
    t = text.lower()
    for key, sec in [("sewer", "water"), ("water", "water"), ("drainage", "water"), ("wwtp", "water"),
                     ("stormwater", "water"), ("cso", "water"), ("wastewater", "water"),
                     ("traffic", "transportation"), ("tunnel", "transportation"), ("bridge", "transportation"),
                     ("highway", "transportation"), ("rail", "transportation"), ("roadway", "transportation"),
                     ("energy", "energy"), ("electric", "energy"), ("solar", "energy"),
                     ("hvac", "buildings"), ("building", "buildings"), ("facilit", "buildings"),
                     ("environmental", "environmental"), ("remediation", "environmental")]:
        if key in t:
            return sec
    return None


def classify_doc(name: str, folder: str = "", ctx_default: str = "other") -> str:
    """Best-effort category from filename + folder. Ordered most-specific first."""
    t = (name + " " + folder).lower()
    # 1. Repetitive compliance / standard forms -> reusable boilerplate
    if any(k in t for k in ("eeo policy", "lobbying", "passport", "saf signed", " saf ", "sub profile",
                            "affirmative action", "non-collusion", "noncollusion", "iran divestment",
                            "utilization plan", "vendor responsibility", "insurance requirement",
                            "standard form", "schedule d", "schedule g", "doing business",
                            "disclosure", "m/wbe", "mwbe utilization", "eeo ")):
        return "boilerplate"
    # 2. Certificates / licenses / affidavits
    if any(k in t for k in ("mbe cert", "dbe", "s3bc", "section 3", "certificate", "certification",
                            " license", "incorporation", "affidavit", "notary", "cert of ",
                            "nysif", "workers comp cert")):
        return "certificate"
    # 3. Financials
    if is_financial(t):
        return "financial"
    # 4. Capability statements / SOQ / company profile
    if any(k in t for k in ("capability statement", "statement of qualification", "company profile",
                            "firm profile", " soq", "qualifications")):
        return "capability_statement"
    # 5. Resumes
    if any(k in t for k in ("resume", "curriculum vitae")) or t.startswith("cv ") or " cv " in t:
        return "resume"
    # 6. Project profiles / sheets
    if any(k in t for k in ("project profile", "project sheet", "cut sheet", "project cut", "past project")):
        return "project"
    # 7. Client references
    if any(k in t for k in ("reference form", "reference letter", "client reference", "references completed")):
        return "client_reference"
    # 8. Solicitation docs (the agency's RFP), only if not our response
    if (any(k in t for k in ("rfp", "rfq", "rfi", "solicitation", "request for proposal",
                             "request for qualif", "addendum", "scope of work", " sow "))
            and not any(k in t for k in ("response", "proposal", "our "))):
        return "rfp"
    # 9. Our proposals / responses
    if any(k in t for k in ("proposal", "response", "cover letter", "bid submission", "technical approach")):
        return "past_proposal"
    return ctx_default


def tags_from(text: str) -> str:
    t = text.lower()
    tags = []
    for key, tag in [("mbe", "MBE"), ("dbe", "DBE"), ("wbe", "WBE"), ("s3bc", "S3BC"),
                     ("section 3", "S3BC"), ("energy", "energy"), ("environmental", "environmental"),
                     ("sewer", "water"), ("traffic", "transportation"), ("tunnel", "transportation")]:
        if key in t and tag not in tags:
            tags.append(tag)
    return ",".join(tags)


def rows_to_seed():
    """Yield dicts of LibraryDocument fields to create."""
    if not SRC.exists():
        print(f"SOURCE NOT FOUND: {SRC}")
        return

    # 1. Certificates folder (also holds some financials + compliance forms)
    certs = SRC / "MBE_Certificates"
    if certs.exists():
        for f in sorted(certs.rglob("*")):
            if f.is_file() and f.suffix.lower() in DOC_EXT:
                cat = classify_doc(f.name, "", "certificate")
                yield dict(category=cat, path=f, title=f.stem[:255],
                           agency=agency_from(f.name), sector=sector_from(f.name), discipline=None,
                           tags=tags_from(f.name), is_current=True)

    # 2. Business Development Planning (proposals, rates, capability, profiles)
    plan = SRC / "Business Development Planning"
    if plan.exists():
        for f in sorted(plan.glob("*")):
            if not (f.is_file() and f.suffix.lower() in DOC_EXT):
                continue
            nl = f.name.lower()
            if not any(k in nl for k in ("proposal", "rfp", "rates", "capability", "profile",
                                         "resume", "qualif", "statement")):
                continue  # skip internal strategy decks / book-of-work
            yield dict(category=classify_doc(f.name, "", "past_proposal"), path=f,
                       title=f.stem[:255], agency=agency_from(f.name), sector=sector_from(f.name),
                       discipline=None, tags=tags_from(f.name), is_current=True)

    # 3. Pursuit folders -> classify each doc (RFP / proposal / forms / etc.)
    for d in sorted(SRC.iterdir()):
        if not d.is_dir() or d.name in SKIP_DIRS:
            continue
        for f in sorted(d.rglob("*")):
            if not (f.is_file() and f.suffix.lower() in DOC_EXT):
                continue
            cat = classify_doc(f.name, "", "past_proposal")
            yield dict(category=cat, path=f, title=f.stem[:255],
                       agency=agency_from(d.name + " " + f.name),
                       sector=sector_from(d.name + " " + f.name), discipline=None,
                       tags=(tags_from(d.name + " " + f.name) or d.name)[:512], is_current=True,
                       status="previous" if cat == "rfp" else None)


def main():
    print(f"Source : {SRC}")
    print(f"Target : {os.environ.get('DATABASE_URL', '(default sqlite)')}")
    print(f"Mode   : {'COMMIT' if COMMIT else 'DRY-RUN (add --commit to write)'}\n")

    s = _db.SessionLocal() if COMMIT else None
    existing = set()
    if COMMIT:
        _db.init_db()
        for cat, fn, sz in s.execute(select(LibraryDocument.category, LibraryDocument.filename,
                                            LibraryDocument.size_bytes)).all():
            existing.add((cat, fn, sz))

    n = skipped = by_cat = 0
    counts: dict[str, int] = {}
    for r in rows_to_seed():
        f: Path = r["path"]
        try:
            sz = f.stat().st_size
        except OSError:
            continue
        if sz == 0 or sz > MAX_BYTES:
            continue
        key = (r["category"], f.name[:255], sz)
        counts[r["category"]] = counts.get(r["category"], 0) + 1
        if COMMIT and key in existing:
            skipped += 1
            continue
        n += 1
        if COMMIT:
            raw = f.read_bytes()
            s.add(LibraryDocument(
                category=r["category"], title=r["title"], description="",
                tags=r["tags"], status=r.get("status"),
                agency=r["agency"], sector=r["sector"], discipline=r["discipline"],
                is_current=r["is_current"], filename=f.name[:255],
                content_type=CT.get(f.suffix.lower(), "application/octet-stream"),
                size_bytes=sz, content=raw))
        else:
            print(f"  [{r['category']:14}] {r['title'][:60]:60} "
                  f"agency={r['agency'] or '-':14} tags={r['tags'] or '-'}")

    if COMMIT:
        s.commit(); s.close()
        print(f"\nCOMMITTED {n} documents ({skipped} already present).")
    print("\nBy category:")
    for c, k in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {c:16} {k}")


if __name__ == "__main__":
    main()
