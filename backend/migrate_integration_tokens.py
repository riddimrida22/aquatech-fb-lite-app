"""Create integration_tokens table (idempotent)."""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{ROOT}/aquatech.db")
os.environ.setdefault("SESSION_SECRET", "dev_session_secret_for_native_pilot_only")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

from sqlalchemy import inspect
from app.db import engine
from app.models import IntegrationToken


def main() -> None:
    insp = inspect(engine)
    if "integration_tokens" not in insp.get_table_names():
        print("Creating table integration_tokens")
        IntegrationToken.__table__.create(engine)
    else:
        print("Table integration_tokens already exists; skipping.")


if __name__ == "__main__":
    main()
