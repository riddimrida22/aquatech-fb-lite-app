import os
from pathlib import Path

import pytest

DB_FILE = Path("/tmp/aquatech_contacts_cleanup_test.db")
if DB_FILE.exists():
    DB_FILE.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{DB_FILE}"
os.environ["SESSION_SECRET"] = "test-secret"
os.environ["ALLOWED_GOOGLE_DOMAIN"] = "aquatechpc.com"
os.environ["DEV_AUTH_BYPASS"] = "true"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:3000"

from app.contacts_cleanup import (  # noqa: E402
    is_empty_contact,
    plan_cleanup,
    run_cleanup,
)
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import Activity, Contact, Pursuit, PursuitContact  # noqa: E402


@pytest.fixture(autouse=True)
def reset_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def _mk(db, **kw):
    c = Contact(full_name=kw.pop("full_name", ""), **kw)
    db.add(c)
    db.flush()
    return c


def test_is_empty_contact():
    assert is_empty_contact(Contact(full_name="", organization="", notes=""))
    assert is_empty_contact(Contact(full_name="   ", organization="  ", org_type="client"))
    assert not is_empty_contact(Contact(full_name="Jane"))
    assert not is_empty_contact(Contact(full_name="", email="a@b.com"))
    assert not is_empty_contact(Contact(full_name="", notes="left a voicemail"))


def test_plan_pure_no_db_needed():
    contacts = [
        Contact(id=1, full_name="Jane Doe", email="jane@acme.com", organization="Acme"),
        Contact(id=2, full_name="Jane Doe", email="JANE@acme.com", organization="Acme", phone="555"),
        Contact(id=3, full_name="  ", organization=""),  # empty
        Contact(id=4, full_name="Bob", organization="Beta"),
    ]
    plan = plan_cleanup(contacts)
    assert plan.empty_ids == [3]
    assert len(plan.merges) == 1
    m = plan.merges[0]
    assert m.canonical_id == 2  # richer (has phone) wins over id order
    assert m.duplicate_ids == [1]


def test_email_dedup_with_reference_repointing():
    with SessionLocal() as db:
        keep = _mk(db, full_name="Jane Doe", email="jane@acme.com", organization="Acme", phone="555")
        dup = _mk(db, full_name="Jane Doe", email="JANE@ACME.com", organization="Acme")
        p = Pursuit(name="Reservoir Study")
        db.add(p)
        db.flush()
        # link + activity point at the DUPLICATE
        db.add(PursuitContact(pursuit_id=p.id, contact_id=dup.id, role="champion"))
        db.add(Activity(contact_id=dup.id, subject="intro call"))
        db.commit()

        report = run_cleanup(db, apply=True)
        assert report["duplicates_removed"] == 1
        assert report["empty_removed"] == 0
        assert report["activities_repointed"] == 1
        assert report["links_repointed"] == 1

        remaining = db.query(Contact).all()
        assert len(remaining) == 1
        assert remaining[0].id == keep.id
        # references now point at the survivor
        assert db.query(PursuitContact).one().contact_id == keep.id
        assert db.query(Activity).one().contact_id == keep.id


def test_unique_constraint_drop_when_both_linked_to_same_pursuit():
    with SessionLocal() as db:
        keep = _mk(db, full_name="Sam Lee", email="sam@x.com")
        dup = _mk(db, full_name="Sam Lee", email="sam@x.com")
        p = Pursuit(name="Bridge")
        db.add(p)
        db.flush()
        db.add(PursuitContact(pursuit_id=p.id, contact_id=keep.id, role="influencer"))
        db.add(PursuitContact(pursuit_id=p.id, contact_id=dup.id, role="technical"))
        db.commit()

        report = run_cleanup(db, apply=True)
        assert report["duplicates_removed"] == 1
        # Only the survivor's link remains; the duplicate's link is dropped (uq constraint).
        links = db.query(PursuitContact).all()
        assert len(links) == 1
        assert links[0].contact_id == keep.id


def test_field_merge_fills_missing_and_unions_notes():
    with SessionLocal() as db:
        _mk(db, full_name="Pat Roe", organization="Gamma", notes="met at conf")
        _mk(db, full_name="Pat Roe", organization="Gamma", email="pat@gamma.com",
            phone="123", title="PM", notes="follow up Q3")
        db.commit()
        report = run_cleanup(db, apply=True)
        assert report["duplicates_removed"] == 1
        surv = db.query(Contact).one()
        assert surv.email == "pat@gamma.com"
        assert surv.phone == "123"
        assert surv.title == "PM"
        assert "met at conf" in surv.notes and "follow up Q3" in surv.notes


def test_name_org_transitive_grouping():
    # a-b share email; b-c share name+org -> all three collapse to one.
    with SessionLocal() as db:
        _mk(db, full_name="Al Vez", email="al@z.com", organization="Zed")
        _mk(db, full_name="Al Vez", email="al@z.com", organization="Zed")
        _mk(db, full_name="Al Vez", organization="Zed", phone="999")
        db.commit()
        report = run_cleanup(db, apply=True)
        assert report["duplicate_groups"] == 1
        assert report["duplicates_removed"] == 2
        assert db.query(Contact).count() == 1


def test_empty_contact_references_are_cleaned():
    with SessionLocal() as db:
        empty = _mk(db)  # totally blank
        p = Pursuit(name="Ghost")
        db.add(p)
        db.flush()
        db.add(PursuitContact(pursuit_id=p.id, contact_id=empty.id))
        db.add(Activity(contact_id=empty.id, subject="orphan note"))
        db.commit()
        report = run_cleanup(db, apply=True)
        assert report["empty_removed"] == 1
        assert db.query(Contact).count() == 0
        assert db.query(PursuitContact).count() == 0
        # activity survives but is unlinked (contact_id nullable)
        act = db.query(Activity).one()
        assert act.contact_id is None


def test_dry_run_changes_nothing_and_apply_is_idempotent():
    with SessionLocal() as db:
        _mk(db, full_name="Dee Cee", email="dee@c.com")
        _mk(db, full_name="Dee Cee", email="dee@c.com")
        _mk(db)  # empty
        db.commit()

        dry = run_cleanup(db, apply=False)
        assert dry["duplicates_removed"] == 1 and dry["empty_removed"] == 1
        assert db.query(Contact).count() == 3  # nothing written

        run_cleanup(db, apply=True)
        assert db.query(Contact).count() == 1

        again = run_cleanup(db, apply=True)
        assert again["duplicates_removed"] == 0 and again["empty_removed"] == 0
        assert again["remaining_contacts"] == 1
