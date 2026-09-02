from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = "sqlite:///./aquatech.db"
    GOOGLE_CLIENT_ID: str = "REPLACE_ME"
    GOOGLE_CLIENT_SECRET: str = "REPLACE_ME"
    GOOGLE_REDIRECT_URI: str = "http://localhost:8000/auth/google/callback"
    ALLOWED_GOOGLE_DOMAIN: str = "aquatechpc.com"
    SESSION_SECRET: str = "dev-secret-change-me"
    FRONTEND_ORIGIN: str = "http://localhost:3000"
    DEV_AUTH_BYPASS: bool = True
    TIMESHEET_REMINDER_ENABLED: bool = False
    TIMESHEET_REMINDER_HOUR_LOCAL: int = 15
    TIMESHEET_REMINDER_MINUTE_LOCAL: int = 0
    TIMESHEET_REMINDER_TIMEZONE: str = "America/New_York"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM_EMAIL: str = ""
    SMTP_USE_TLS: bool = True
    RECURRING_INVOICE_ENABLED: bool = True
    RECURRING_INVOICE_RUN_HOUR_LOCAL: int = 8
    RECURRING_INVOICE_RUN_MINUTE_LOCAL: int = 5
    RECURRING_INVOICE_TIMEZONE: str = "America/New_York"
    PAYMENT_LINK_DEFAULT_EXPIRY_DAYS: int = 14
    PAYMENT_LINKS_ENABLED: bool = False
    PLAID_CLIENT_ID: str = ""
    PLAID_SECRET: str = ""
    PLAID_ENV: str = "sandbox"
    PLAID_PRODUCTS: str = "transactions"
    PLAID_COUNTRY_CODES: str = "US"
    # Required for OAuth institutions (e.g. Dime Community Bank). Must be
    # registered verbatim in the Plaid dashboard under Allowed redirect URIs.
    PLAID_REDIRECT_URI: str = ""
    FRESHBOOKS_TRANSITION_DIR: str = "/mnt/c/Users/bertr/Downloads/AqtPM-Uploads"
    # FreshBooks API integration (Private OAuth App)
    FRESHBOOKS_CLIENT_ID: str = ""
    FRESHBOOKS_CLIENT_SECRET: str = ""
    FRESHBOOKS_REDIRECT_URI: str = "https://localhost:8000/auth/freshbooks/callback"
    FRESHBOOKS_API_VERSION: str = "2023-02-20"
    # Paychex Flex API — company-owned app (Company Settings > Integrated apps).
    # OAuth2 client_credentials; no redirect URI and no refresh token.
    PAYCHEX_CLIENT_ID: str = ""
    PAYCHEX_CLIENT_SECRET: str = ""
    PAYCHEX_API_BASE: str = "https://api.paychex.com"
    SESSION_HTTPS_ONLY: bool = False
    SESSION_SAME_SITE: str = "lax"
    CORS_ALLOW_INTERNAL_REGEX: bool = True
    # Payroll PII encryption (SSN, bank). A urlsafe-base64 32-byte Fernet key.
    # If blank, a stable key is derived from SESSION_SECRET (fine for dev; set a
    # dedicated key in prod). Generate: python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
    PAYROLL_ENC_KEY: str = ""
    # AI Assistant ("Ask AqtPM") — natural-language company Q&A
    ANTHROPIC_API_KEY: str = ""
    ASSISTANT_MODEL: str = "claude-opus-4-8"
    # iCloud (CardDAV) contact sync — app-specific password only; never a real Apple password
    APPLE_ID: str = ""
    APPLE_APP_PASSWORD: str = ""
    ICLOUD_CARDDAV_URL: str = "https://contacts.icloud.com/.well-known/carddav"
    # Daily auto-sync of external integrations (bank + accounting)
    PLAID_DAILY_SYNC_ENABLED: bool = True
    FRESHBOOKS_DAILY_SYNC_ENABLED: bool = True
    # Master kill-switch for ALL FreshBooks syncing (10-min time-sync + daily full sync +
    # boot catch-up). Default True keeps current behavior. Set False at the 2026-08-31
    # FreshBooks cut-over so nothing tries to phone the cancelled API. The app is the
    # system of record now; disabling this does NOT affect billed/is_billable (those are
    # app-authoritative). See memory: aquatechpm_billed_flag_wiring.
    FRESHBOOKS_SYNC_ENABLED: bool = True
    INTEGRATIONS_SYNC_HOUR_LOCAL: int = 6
    INTEGRATIONS_SYNC_TIMEZONE: str = "America/New_York"


@lru_cache
def get_settings() -> Settings:
    return Settings()


def clear_settings_cache() -> None:
    get_settings.cache_clear()
