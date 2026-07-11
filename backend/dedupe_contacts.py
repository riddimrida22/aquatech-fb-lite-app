"""Consolidate duplicate + remove empty BD Contacts.

Dry-run by default (prints what WOULD change). Pass --apply to commit.

Usage (prod):
    docker exec aquatechpm_backend_1 python dedupe_contacts.py            # preview
    docker exec aquatechpm_backend_1 python dedupe_contacts.py --apply    # execute

Uses the ORM via SessionLocal, so it works against SQLite (dev) and Postgres (prod).
Logic lives in app/contacts_cleanup.py and is unit-tested. Idempotent: a second run
finds nothing to do.
"""
import json
import sys

from app.contacts_cleanup import run_cleanup
from app.db import SessionLocal


def main() -> None:
    apply = "--apply" in sys.argv[1:]

    with SessionLocal() as db:
        report = run_cleanup(db, apply=apply)

    mode = "APPLIED" if report["applied"] else "DRY-RUN (no changes written)"
    print(f"=== Contact cleanup — {mode} ===")
    print(f"Total contacts scanned : {report['total_contacts']}")
    print(f"Empty contacts removed  : {report['empty_removed']}")
    print(f"Duplicate groups        : {report['duplicate_groups']}")
    print(f"Duplicate rows removed  : {report['duplicates_removed']}")
    print(f"Contacts remaining      : {report['remaining_contacts']}")
    print(
        "References moved        : "
        f"{report['links_repointed']} pursuit-links repointed, "
        f"{report['links_dropped']} dropped, "
        f"{report['activities_repointed']} activities repointed, "
        f"{report['activities_unlinked']} activities unlinked"
    )

    if report["merges"]:
        print("\n--- Merges (survivor <- duplicates) ---")
        for m in report["merges"]:
            dups = ", ".join(str(d) for d in m["duplicate_ids"])
            print(f"  contact #{m['canonical_id']} <- [{dups}]")
            if m["field_updates"]:
                print(f"      fill: {json.dumps(m['field_updates'], ensure_ascii=False)}")
    if report["empty_ids"]:
        print(f"\n--- Empty contact ids removed ---\n  {report['empty_ids']}")

    if not report["applied"] and not (report["merges"] or report["empty_ids"]):
        print("\nNothing to clean up — contacts are already consolidated.")
    elif not report["applied"]:
        print("\nRe-run with --apply to commit these changes.")


if __name__ == "__main__":
    main()
