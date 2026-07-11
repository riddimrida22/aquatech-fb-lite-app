"""iCloud (CardDAV) contact sync for the BD address book.

Apple exposes iCloud Contacts only over **CardDAV** (there is no REST API). This
module lets AqtPM pull contacts down from iCloud and push the consolidated app
contacts back up, so the de-duplicated address book (see contacts_cleanup.py) can
be reflected in iCloud.

Auth: an Apple ID + an **app-specific password** (appleid.apple.com → Sign-In &
Security → App-Specific Passwords). Credentials come from settings/env only — they
are never stored in the repo or the database.

Structure:
  * vCard 3.0 (RFC 2426/6350) serialize + parse — pure, self-contained (no external
    vCard dependency), fully unit-tested.
  * `CardDAVClient` — an abstract transport (fetch_all / put_contact / delete_contact)
    so the sync logic is testable with an in-memory fake. `ICloudCardDAVClient` is the
    real HTTP implementation (isolated; needs a live-credential smoke test on prod,
    since this build environment blocks egress to icloud.com).
  * `pull_from_icloud` / `push_to_icloud` — the sync orchestration, reusing the dedup
    engine on pull.

See DECISIONS.md D-033.
"""

from __future__ import annotations

import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.orm import Session

from .contacts_cleanup import normalize_email, run_cleanup
from .models import Contact
from .settings import get_settings

# Custom vCard property that round-trips the AqtPM contact id, so a contact that
# originated here can be matched back on a later pull even before it has a UID stored.
_X_AQTPM_ID = "X-AQTPM-ID"


# --------------------------------------------------------------------------- #
# vCard 3.0 mapping (pure)
# --------------------------------------------------------------------------- #

def _escape(value: str) -> str:
    return (
        (value or "")
        .replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def _unescape(value: str) -> str:
    out, i = [], 0
    while i < len(value):
        ch = value[i]
        if ch == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            out.append("\n" if nxt in ("n", "N") else nxt)
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _structured_components(raw: str) -> list[str]:
    """Split a structured value on UNescaped ';', then unescape each component.

    Must split before unescaping — otherwise an escaped ';' inside a single field
    (e.g. an org name "A;B Inc.") would be mistaken for a structural separator.
    """
    comps, buf, i = [], [], 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            buf.append(raw[i:i + 2])
            i += 2
        elif ch == ";":
            comps.append("".join(buf))
            buf = []
            i += 1
        else:
            buf.append(ch)
            i += 1
    comps.append("".join(buf))
    return [_unescape(c) for c in comps]


def _split_name(full_name: str) -> tuple[str, str]:
    """Best-effort (family, given) split for the structured N property."""
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return "", parts[0]
    return parts[-1], " ".join(parts[:-1])


def contact_to_vcard(c: Contact) -> str:
    """Serialize a Contact to a vCard 3.0 string."""
    family, given = _split_name(c.full_name or "")
    uid = (c.icloud_uid or "").strip() or new_uid()
    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        f"UID:{_escape(uid)}",
        f"FN:{_escape(c.full_name or '')}",
        f"N:{_escape(family)};{_escape(given)};;;",
    ]
    if (c.organization or "").strip():
        lines.append(f"ORG:{_escape(c.organization)}")
    if (c.title or "").strip():
        lines.append(f"TITLE:{_escape(c.title)}")
    if (c.email or "").strip():
        lines.append(f"EMAIL;TYPE=INTERNET:{_escape(c.email)}")
    if (c.phone or "").strip():
        lines.append(f"TEL:{_escape(c.phone)}")
    if (c.notes or "").strip():
        lines.append(f"NOTE:{_escape(c.notes)}")
    if c.id is not None:
        lines.append(f"{_X_AQTPM_ID}:{c.id}")
    lines.append("END:VCARD")
    return "\r\n".join(lines) + "\r\n"


def _unfold(text: str) -> list[str]:
    """Undo RFC line folding (continuation lines begin with a space or tab)."""
    raw = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    folded: list[str] = []
    for line in raw:
        if line[:1] in (" ", "\t") and folded:
            folded[-1] += line[1:]
        else:
            folded.append(line)
    return folded


@dataclass
class ParsedCard:
    uid: str = ""
    full_name: str = ""
    title: str = ""
    organization: str = ""
    email: str = ""
    phone: str = ""
    notes: str = ""
    aqtpm_id: int | None = None


def parse_vcard(text: str) -> ParsedCard:
    """Parse a single vCard 3.0 block into a ParsedCard (first value wins per field)."""
    card = ParsedCard()
    n_family = n_given = ""
    for line in _unfold(text):
        if not line or ":" not in line:
            continue
        name_part, raw_value = line.split(":", 1)
        prop = name_part.split(";", 1)[0].strip().upper()
        raw_value = raw_value.strip()
        value = _unescape(raw_value)
        if prop == "UID" and not card.uid:
            card.uid = value
        elif prop == "FN" and not card.full_name:
            card.full_name = value
        elif prop == "N" and not (n_family or n_given):
            comps = _structured_components(raw_value)
            n_family = comps[0] if len(comps) > 0 else ""
            n_given = comps[1] if len(comps) > 1 else ""
        elif prop == "ORG" and not card.organization:
            card.organization = _structured_components(raw_value)[0].strip()
        elif prop == "TITLE" and not card.title:
            card.title = value
        elif prop == "EMAIL" and not card.email:
            card.email = value
        elif prop == "TEL" and not card.phone:
            card.phone = value
        elif prop == "NOTE" and not card.notes:
            card.notes = value
        elif prop == _X_AQTPM_ID and card.aqtpm_id is None:
            try:
                card.aqtpm_id = int(value)
            except ValueError:
                pass
    if not card.full_name:
        card.full_name = " ".join(p for p in (n_given, n_family) if p).strip()
    return card


def new_uid() -> str:
    """Fresh vCard UID. uuid4 draws from os.urandom (fine outside workflow scripts)."""
    return f"aqtpm-{uuid.uuid4()}"


# --------------------------------------------------------------------------- #
# CardDAV transport
# --------------------------------------------------------------------------- #

@dataclass
class RemoteCard:
    uid: str
    vcard: str
    etag: str = ""
    href: str = ""


class CardDAVClient:
    """Transport interface the sync logic depends on (real impl or test fake)."""

    def fetch_all(self) -> list[RemoteCard]:  # pragma: no cover - interface
        raise NotImplementedError

    def put_contact(self, uid: str, vcard: str, etag: str | None = None) -> RemoteCard:  # pragma: no cover
        raise NotImplementedError

    def delete_contact(self, uid: str, etag: str | None = None) -> None:  # pragma: no cover
        raise NotImplementedError


_DAV = "{DAV:}"
_CARD = "{urn:ietf:params:xml:ns:carddav}"


class ICloudCardDAVClient(CardDAVClient):
    """Live iCloud CardDAV client. Isolated + unverified against production iCloud
    in this build (egress to icloud.com is blocked here); smoke-test with real
    credentials before relying on it. All XML/HTTP lives here so the sync logic
    above stays transport-agnostic and testable."""

    WELL_KNOWN = "https://contacts.icloud.com/.well-known/carddav"

    def __init__(self, apple_id: str, app_password: str, base_url: str = WELL_KNOWN,
                 session=None, timeout: int = 30) -> None:
        import requests  # local import: only needed for the live path

        self.timeout = timeout
        self._session = session or requests.Session()
        self._session.auth = (apple_id, app_password)
        self._session.headers.update({"User-Agent": "AqtPM-CardDAV/1.0"})
        self._base_url = base_url
        self._addressbook_url: str | None = None

    def _request(self, method: str, url: str, *, depth: str | None = None,
                 body: str | None = None, headers: dict | None = None):
        hdrs = {"Content-Type": 'text/xml; charset="utf-8"'}
        if depth is not None:
            hdrs["Depth"] = depth
        if headers:
            hdrs.update(headers)
        resp = self._session.request(method, url, data=body, headers=hdrs,
                                     timeout=self.timeout, allow_redirects=True)
        resp.raise_for_status()
        return resp

    def _propfind(self, url: str, body: str, depth: str = "0"):
        return ET.fromstring(self._request("PROPFIND", url, depth=depth, body=body).content)

    def _discover_addressbook(self) -> str:
        if self._addressbook_url:
            return self._addressbook_url
        # 1) current-user-principal
        principal_body = (
            '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/>'
            "</d:prop></d:propfind>"
        )
        root = self._propfind(self._base_url, principal_body)
        principal = self._first_href(root, f"{_DAV}current-user-principal")
        principal_url = urljoin(self._base_url, principal) if principal else self._base_url
        # 2) addressbook-home-set
        home_body = (
            '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">'
            "<d:prop><c:addressbook-home-set/></d:prop></d:propfind>"
        )
        root = self._propfind(principal_url, home_body)
        home = self._first_href(root, f"{_CARD}addressbook-home-set")
        home_url = urljoin(principal_url, home) if home else principal_url
        # 3) first addressbook collection under the home set
        list_body = (
            '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
        )
        root = self._propfind(home_url, list_body, depth="1")
        for resp in root.findall(f"{_DAV}response"):
            rtype = resp.find(f".//{_DAV}resourcetype")
            if rtype is not None and rtype.find(f"{_CARD}addressbook") is not None:
                href = resp.find(f"{_DAV}href")
                if href is not None and href.text:
                    self._addressbook_url = urljoin(home_url, href.text)
                    return self._addressbook_url
        self._addressbook_url = home_url
        return self._addressbook_url

    @staticmethod
    def _first_href(root: ET.Element, prop_tag: str) -> str | None:
        prop = root.find(f".//{prop_tag}")
        if prop is None:
            return None
        href = prop.find(f"{_DAV}href")
        return href.text if href is not None else None

    def _href_for(self, uid: str) -> str:
        book = self._discover_addressbook()
        if not book.endswith("/"):
            book += "/"
        return urljoin(book, f"{uid}.vcf")

    def fetch_all(self) -> list[RemoteCard]:
        book = self._discover_addressbook()
        report = (
            '<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">'
            "<d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>"
        )
        root = ET.fromstring(self._request("REPORT", book, depth="1", body=report).content)
        cards: list[RemoteCard] = []
        for resp in root.findall(f"{_DAV}response"):
            href_el = resp.find(f"{_DAV}href")
            data_el = resp.find(f".//{_CARD}address-data")
            etag_el = resp.find(f".//{_DAV}getetag")
            if data_el is None or not (data_el.text or "").strip():
                continue
            vcard = data_el.text
            parsed = parse_vcard(vcard)
            cards.append(RemoteCard(
                uid=parsed.uid,
                vcard=vcard,
                etag=(etag_el.text or "").strip() if etag_el is not None else "",
                href=urljoin(book, href_el.text) if href_el is not None and href_el.text else "",
            ))
        return cards

    def put_contact(self, uid: str, vcard: str, etag: str | None = None) -> RemoteCard:
        href = self._href_for(uid)
        headers = {"Content-Type": "text/vcard; charset=utf-8"}
        headers["If-Match" if etag else "If-None-Match"] = etag or "*"
        resp = self._request("PUT", href, body=vcard, headers=headers)
        return RemoteCard(uid=uid, vcard=vcard, etag=resp.headers.get("ETag", ""), href=href)

    def delete_contact(self, uid: str, etag: str | None = None) -> None:
        headers = {"If-Match": etag} if etag else None
        self._request("DELETE", self._href_for(uid), headers=headers)


def build_client_from_settings() -> CardDAVClient | None:
    """Construct the live iCloud client from settings, or None if not configured."""
    s = get_settings()
    apple_id = (getattr(s, "APPLE_ID", "") or "").strip()
    app_pw = (getattr(s, "APPLE_APP_PASSWORD", "") or "").strip()
    if not apple_id or not app_pw:
        return None
    base = (getattr(s, "ICLOUD_CARDDAV_URL", "") or ICloudCardDAVClient.WELL_KNOWN).strip()
    return ICloudCardDAVClient(apple_id, app_pw, base_url=base)


def is_configured() -> bool:
    s = get_settings()
    return bool((getattr(s, "APPLE_ID", "") or "").strip()
                and (getattr(s, "APPLE_APP_PASSWORD", "") or "").strip())


# --------------------------------------------------------------------------- #
# Sync orchestration
# --------------------------------------------------------------------------- #

def _match_local(db: Session, parsed: ParsedCard, by_email: dict[str, Contact]) -> Contact | None:
    if parsed.uid:
        hit = db.scalar(select(Contact).where(Contact.icloud_uid == parsed.uid))
        if hit:
            return hit
    if parsed.aqtpm_id is not None:
        hit = db.get(Contact, parsed.aqtpm_id)
        if hit:
            return hit
    email = normalize_email(parsed.email)
    if email and email in by_email:
        return by_email[email]
    return None


def pull_from_icloud(db: Session, client: CardDAVClient, dedup: bool = True) -> dict:
    """Import iCloud contacts into the app, then (optionally) consolidate.

    Remote values win on conflict for existing matches; non-empty local fields are
    never overwritten with blanks. New remote cards become new contacts.
    """
    remote = client.fetch_all()
    existing = db.scalars(select(Contact)).all()
    by_email = {normalize_email(c.email): c for c in existing if normalize_email(c.email)}

    created = updated = 0
    for card in remote:
        parsed = parse_vcard(card.vcard)
        local = _match_local(db, parsed, by_email)
        if local is None:
            local = Contact(full_name=parsed.full_name)
            db.add(local)
            created += 1
        else:
            updated += 1
        # Remote wins where it has a value; keep local value when remote is blank.
        for field in ("full_name", "title", "organization", "email", "phone", "notes"):
            val = (getattr(parsed, field) or "").strip()
            if val:
                setattr(local, field, val)
        local.icloud_uid = parsed.uid or local.icloud_uid
        local.icloud_etag = card.etag or local.icloud_etag
        if normalize_email(local.email):
            by_email[normalize_email(local.email)] = local

    db.commit()
    report = {"pulled": len(remote), "created": created, "updated": updated}
    if dedup:
        report["dedup"] = run_cleanup(db, apply=True)
    return report


def push_to_icloud(db: Session, client: CardDAVClient) -> dict:
    """Push every app contact up to iCloud (create or update its vCard)."""
    contacts = db.scalars(select(Contact)).all()
    created = updated = failed = 0
    errors: list[str] = []
    for c in contacts:
        uid = (c.icloud_uid or "").strip() or new_uid()
        had_uid = bool((c.icloud_uid or "").strip())
        try:
            result = client.put_contact(uid, contact_to_vcard(c),
                                        etag=c.icloud_etag if had_uid else None)
            c.icloud_uid = result.uid or uid
            c.icloud_etag = result.etag or c.icloud_etag
            updated += 1 if had_uid else 0
            created += 0 if had_uid else 1
        except Exception as exc:  # keep pushing the rest; report failures
            failed += 1
            errors.append(f"#{c.id} {c.full_name!r}: {str(exc)[:160]}")
    db.commit()
    return {"pushed": len(contacts), "created": created, "updated": updated,
            "failed": failed, "errors": errors}
