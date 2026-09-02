"""App-level encryption for payroll PII (SSN, bank account).

Fernet (AES-128-CBC + HMAC). Ciphertext is stored in the *_enc columns; plaintext
never touches the DB or git. The key comes from settings.PAYROLL_ENC_KEY; if unset,
a stable key is derived from SESSION_SECRET so dev works out of the box (set a
dedicated PAYROLL_ENC_KEY in prod).
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from ..settings import get_settings


def _key() -> bytes:
    s = get_settings()
    raw = (getattr(s, "PAYROLL_ENC_KEY", "") or "").strip()
    if raw:
        return raw.encode()
    # dev fallback: derive a stable 32-byte urlsafe key from the session secret
    digest = hashlib.sha256(("payroll-pii:" + s.SESSION_SECRET).encode()).digest()
    return base64.urlsafe_b64encode(digest)


def encrypt(plain: str | None) -> str | None:
    if not plain:
        return None
    return Fernet(_key()).encrypt(str(plain).encode()).decode()


def decrypt(token: str | None) -> str | None:
    if not token:
        return None
    try:
        return Fernet(_key()).decrypt(token.encode()).decode()
    except InvalidToken:
        return None


def mask_ssn(token: str | None) -> str | None:
    """Return ***-**-#### for display; never expose the full SSN in the UI/API."""
    d = decrypt(token)
    if not d:
        return None
    digits = "".join(ch for ch in d if ch.isdigit())
    return f"***-**-{digits[-4:]}" if len(digits) >= 4 else "***"


def last4(token: str | None) -> str | None:
    d = decrypt(token)
    if not d:
        return None
    digits = "".join(ch for ch in d if ch.isdigit())
    return digits[-4:] if len(digits) >= 4 else None
