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


@lru_cache
def get_settings() -> Settings:
    return Settings()


def clear_settings_cache() -> None:
    get_settings.cache_clear()
