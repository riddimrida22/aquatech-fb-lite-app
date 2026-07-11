"""Dedupe + prune a vCard (.vcf) contacts export — for Google / iCloud / phone.

Both Google Contacts and iCloud can export the whole address book to a single
.vcf file. This tool reads that file, consolidates duplicates and drops empty
cards using the SAME matching rules as the in-app cleanup
(app/contacts_cleanup.py), and writes a cleaned .vcf you can re-import.

It never touches any live account — it only reads the input file and writes a new
output file, so it is safe to run repeatedly.

Usage:
    python dedupe_vcard.py contacts.vcf                 # writes contacts.cleaned.vcf
    python dedupe_vcard.py contacts.vcf -o out.vcf      # choose the output path
    python dedupe_vcard.py contacts.vcf --report-only   # summary only, no file written

Field/UID handling: each surviving card keeps its original UID (so a re-import
updates the existing contact instead of creating a new one); merged-away duplicates
contribute their missing fields + notes to the survivor before being dropped.
"""
import argparse
import sys

from app.contacts_cleanup import is_empty_contact, plan_cleanup
from app.icloud_contacts import contact_to_vcard, parse_vcard
from app.models import Contact


def split_vcards(text: str) -> list[str]:
    """Split a multi-card .vcf blob into individual BEGIN…END vCard blocks."""
    blocks: list[str] = []
    current: list[str] = []
    in_card = False
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.strip()
        if stripped.upper() == "BEGIN:VCARD":
            in_card = True
            current = [line]
        elif stripped.upper() == "END:VCARD":
            if in_card:
                current.append(line)
                blocks.append("\n".join(current))
            in_card = False
            current = []
        elif in_card:
            current.append(line)
    return blocks


def _card_to_contact(block: str, idx: int) -> Contact:
    p = parse_vcard(block)
    c = Contact(
        id=idx,
        full_name=p.full_name or "",
        title=p.title or None,
        organization=p.organization or "",
        email=p.email or None,
        phone=p.phone or None,
        notes=p.notes or "",
    )
    c.icloud_uid = p.uid or None  # preserve original UID for a clean re-import
    return c


def dedupe_vcards(text: str) -> tuple[list[Contact], dict]:
    """Return (surviving contacts, summary) for a .vcf blob."""
    blocks = split_vcards(text)
    contacts = [_card_to_contact(b, i + 1) for i, b in enumerate(blocks)]
    by_id = {c.id: c for c in contacts}

    plan = plan_cleanup(contacts)

    # Apply merges in-memory: fill survivor fields, then drop duplicates + empties.
    dropped: set[int] = set(plan.empty_ids)
    for m in plan.merges:
        survivor = by_id[m.canonical_id]
        for field, val in m.field_updates.items():
            setattr(survivor, field, val)
        dropped.update(m.duplicate_ids)

    survivors = [c for c in contacts if c.id not in dropped and not is_empty_contact(c)]
    summary = {
        "total_cards": len(blocks),
        "empty_removed": len(plan.empty_ids),
        "duplicate_groups": len(plan.merges),
        "duplicates_removed": len(plan.duplicate_ids),
        "remaining": len(survivors),
    }
    return survivors, summary


def main() -> None:
    ap = argparse.ArgumentParser(description="Dedupe + prune a vCard (.vcf) contacts export.")
    ap.add_argument("input", help="path to the .vcf export")
    ap.add_argument("-o", "--output", help="output path (default: <input>.cleaned.vcf)")
    ap.add_argument("--report-only", action="store_true", help="print summary, write nothing")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8-sig") as fh:
        text = fh.read()

    survivors, summary = dedupe_vcards(text)

    print("=== vCard cleanup ===")
    print(f"Cards read          : {summary['total_cards']}")
    print(f"Empty removed       : {summary['empty_removed']}")
    print(f"Duplicate groups    : {summary['duplicate_groups']}")
    print(f"Duplicates removed  : {summary['duplicates_removed']}")
    print(f"Contacts remaining  : {summary['remaining']}")

    if args.report_only:
        print("\n--report-only: no file written.")
        return

    out_path = args.output or (args.input.rsplit(".", 1)[0] + ".cleaned.vcf")
    with open(out_path, "w", encoding="utf-8") as fh:
        for c in survivors:
            c.id = None  # drop the transient row index so no X-AQTPM-ID leaks into the export
            fh.write(contact_to_vcard(c))
    print(f"\nCleaned file written: {out_path}")


if __name__ == "__main__":
    main()
