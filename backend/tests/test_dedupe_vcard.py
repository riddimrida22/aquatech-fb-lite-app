import os

os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/aquatech_vcard_test.db")
os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("ALLOWED_GOOGLE_DOMAIN", "aquatechpc.com")

from dedupe_vcard import dedupe_vcards, split_vcards  # noqa: E402

SAMPLE = """BEGIN:VCARD
VERSION:3.0
UID:u1
FN:Jane Doe
ORG:Acme
EMAIL:jane@acme.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
UID:u2
FN:Jane Doe
ORG:Acme
EMAIL:JANE@ACME.COM
TEL:555-1212
END:VCARD
BEGIN:VCARD
VERSION:3.0
UID:u3
FN:
END:VCARD
BEGIN:VCARD
VERSION:3.0
UID:u4
FN:Bob Smith
ORG:Beta
EMAIL:bob@beta.com
END:VCARD
"""


def test_split_counts_blocks():
    assert len(split_vcards(SAMPLE)) == 4


def test_dedupe_merges_and_prunes():
    survivors, summary = dedupe_vcards(SAMPLE)
    assert summary["total_cards"] == 4
    assert summary["empty_removed"] == 1        # the blank FN card
    assert summary["duplicates_removed"] == 1   # the two Jane Doe cards -> one
    assert summary["remaining"] == 2            # Jane + Bob
    names = sorted(c.full_name for c in survivors)
    assert names == ["Bob Smith", "Jane Doe"]
    jane = next(c for c in survivors if c.full_name == "Jane Doe")
    assert jane.phone == "555-1212"             # richer card won, kept the phone


def test_crlf_and_bom_tolerant():
    survivors, summary = dedupe_vcards("﻿" + SAMPLE.replace("\n", "\r\n"))
    assert summary["remaining"] == 2


def test_empty_input():
    survivors, summary = dedupe_vcards("")
    assert summary == {"total_cards": 0, "empty_removed": 0, "duplicate_groups": 0,
                       "duplicates_removed": 0, "remaining": 0}
    assert survivors == []
