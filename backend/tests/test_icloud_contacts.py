import os
from pathlib import Path

import pytest

DB_FILE = Path("/tmp/aquatech_icloud_test.db")
if DB_FILE.exists():
    DB_FILE.unlink()

os.environ["DATABASE_URL"] = f"sqlite:///{DB_FILE}"
os.environ["SESSION_SECRET"] = "test-secret"
os.environ["ALLOWED_GOOGLE_DOMAIN"] = "aquatechpc.com"
os.environ["DEV_AUTH_BYPASS"] = "true"
os.environ["FRONTEND_ORIGIN"] = "http://localhost:3000"

from app import icloud_contacts as ic  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import Contact  # noqa: E402


@pytest.fixture(autouse=True)
def reset_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


class FakeCardDAVClient(ic.CardDAVClient):
    """In-memory CardDAV stand-in keyed by uid."""

    def __init__(self, seed: list[ic.RemoteCard] | None = None):
        self.store: dict[str, ic.RemoteCard] = {c.uid: c for c in (seed or [])}
        self._seq = 0

    def fetch_all(self):
        return list(self.store.values())

    def put_contact(self, uid, vcard, etag=None):
        self._seq += 1
        card = ic.RemoteCard(uid=uid, vcard=vcard, etag=f'"etag-{self._seq}"',
                             href=f"/card/{uid}.vcf")
        self.store[uid] = card
        return card

    def delete_contact(self, uid, etag=None):
        self.store.pop(uid, None)


# --------------------------- vCard mapping ---------------------------------- #

def test_vcard_roundtrip_escapes_special_chars():
    c = Contact(id=3, full_name="José O'Brien", organization="A;B, Inc.",
                title="Sr. PM", email="jo@x.com", phone="+1 (555) 2",
                notes="first line\nsecond; with, commas \\ slash")
    parsed = ic.parse_vcard(ic.contact_to_vcard(c))
    assert parsed.full_name == "José O'Brien"
    assert parsed.organization == "A;B, Inc."
    assert parsed.title == "Sr. PM"
    assert parsed.email == "jo@x.com"
    assert parsed.notes == "first line\nsecond; with, commas \\ slash"
    assert parsed.aqtpm_id == 3


def test_parse_falls_back_to_N_when_no_FN_and_unfolds():
    vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:u1\r\nN:Smith;Al;;;\r\nNOTE:a very lo\r\n ng note\r\nEND:VCARD\r\n"
    parsed = ic.parse_vcard(vcard)
    assert parsed.full_name == "Al Smith"
    assert parsed.notes == "a very long note"  # line unfolding


# --------------------------- pull sync -------------------------------------- #

def _vc(uid, fn, email="", org="", note="", aqtpm_id=None):
    c = Contact(id=aqtpm_id, full_name=fn, email=email, organization=org, notes=note)
    c.icloud_uid = uid
    return ic.RemoteCard(uid=uid, vcard=ic.contact_to_vcard(c), etag=f'"e-{uid}"')


def test_pull_creates_new_contacts_and_links_uid():
    client = FakeCardDAVClient([
        _vc("u1", "Jane Doe", email="jane@acme.com", org="Acme"),
        _vc("u2", "Bob Roe", email="bob@beta.com", org="Beta"),
    ])
    with SessionLocal() as db:
        report = ic.pull_from_icloud(db, client, dedup=True)
        assert report["pulled"] == 2 and report["created"] == 2
        rows = db.query(Contact).all()
        assert {r.icloud_uid for r in rows} == {"u1", "u2"}
        assert all(r.icloud_etag for r in rows)


def test_pull_matches_existing_by_email_and_remote_wins_nonblank():
    with SessionLocal() as db:
        local = Contact(full_name="Jane Doe", email="jane@acme.com", organization="")
        db.add(local)
        db.commit()
        client = FakeCardDAVClient([_vc("u1", "Jane Doe", email="JANE@acme.com", org="Acme Corp")])
        report = ic.pull_from_icloud(db, client, dedup=True)
        assert report["created"] == 0 and report["updated"] == 1
        rows = db.query(Contact).all()
        assert len(rows) == 1
        assert rows[0].icloud_uid == "u1"
        assert rows[0].organization == "Acme Corp"  # remote filled the blank


def test_pull_then_dedup_collapses_duplicates():
    # Same person, same name+org but DIFFERENT emails -> pull creates two rows
    # (email-match can't catch it); the dedup pass then collapses them by name+org.
    with SessionLocal() as db:
        client = FakeCardDAVClient([
            _vc("u1", "Sam Lee", email="sam.work@x.com", org="Xco"),
            _vc("u2", "Sam Lee", email="sam.home@x.com", org="Xco", note="second copy"),
        ])
        report = ic.pull_from_icloud(db, client, dedup=True)
        assert report["pulled"] == 2
        assert report["created"] == 2
        assert report["dedup"]["duplicates_removed"] == 1
        assert db.query(Contact).count() == 1


def test_pull_merges_same_email_without_creating_duplicate():
    # Same email across two cards -> pull itself matches the second onto the first.
    with SessionLocal() as db:
        client = FakeCardDAVClient([
            _vc("u1", "Sam Lee", email="sam@x.com"),
            _vc("u2", "Sam Lee", email="SAM@x.com", note="second copy"),
        ])
        report = ic.pull_from_icloud(db, client, dedup=True)
        assert report["created"] == 1 and report["updated"] == 1
        assert db.query(Contact).count() == 1


# --------------------------- push sync -------------------------------------- #

def test_push_creates_uids_and_stores_etag():
    with SessionLocal() as db:
        db.add(Contact(full_name="New Person", email="np@x.com"))
        db.add(Contact(full_name="Other Person", email="op@x.com"))
        db.commit()
        client = FakeCardDAVClient()
        report = ic.push_to_icloud(db, client)
        assert report["pushed"] == 2 and report["created"] == 2 and report["failed"] == 0
        rows = db.query(Contact).all()
        assert all(r.icloud_uid and r.icloud_etag for r in rows)
        # a subsequent pull round-trips the same people back (uid-matched, no new rows)
        again = ic.pull_from_icloud(db, client, dedup=False)
        assert again["created"] == 0 and again["updated"] == 2


def test_push_reuses_existing_uid_as_update():
    with SessionLocal() as db:
        c = Contact(full_name="Keep Uid", email="k@x.com")
        c.icloud_uid = "existing-uid"
        db.add(c)
        db.commit()
        client = FakeCardDAVClient()
        report = ic.push_to_icloud(db, client)
        assert report["created"] == 0 and report["updated"] == 1
        assert "existing-uid" in client.store


def test_push_reports_failures_without_aborting():
    class FlakyClient(FakeCardDAVClient):
        def put_contact(self, uid, vcard, etag=None):
            if "boom" in vcard:
                raise RuntimeError("server said no")
            return super().put_contact(uid, vcard, etag)

    with SessionLocal() as db:
        db.add(Contact(full_name="Good One", email="g@x.com"))
        db.add(Contact(full_name="boom", email="b@x.com"))
        db.commit()
        report = ic.push_to_icloud(db, FlakyClient())
        assert report["pushed"] == 2
        assert report["failed"] == 1
        assert report["created"] == 1
        assert len(report["errors"]) == 1


def test_is_configured_reflects_settings(monkeypatch):
    from app import settings as settings_mod

    settings_mod.get_settings.cache_clear()
    monkeypatch.setenv("APPLE_ID", "")
    monkeypatch.setenv("APPLE_APP_PASSWORD", "")
    settings_mod.get_settings.cache_clear()
    assert ic.is_configured() is False
    assert ic.build_client_from_settings() is None

    monkeypatch.setenv("APPLE_ID", "someone@icloud.com")
    monkeypatch.setenv("APPLE_APP_PASSWORD", "abcd-efgh-ijkl-mnop")
    settings_mod.get_settings.cache_clear()
    assert ic.is_configured() is True
    settings_mod.get_settings.cache_clear()
