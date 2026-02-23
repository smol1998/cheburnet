# backend_app/config.py

from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
    )

    # =========================
    # DATABASE
    # =========================
    database_url: str = f"sqlite:///{BASE_DIR / 'mvp.db'}"

    # =========================
    # JWT
    # =========================
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7

    # =========================
    # STORAGE
    # =========================
    storage_dir: str = str(BASE_DIR / "storage")

    # =========================
    # VAPID (Web Push)
    # =========================
    VAPID_PRIVATE_KEY_PEM: str | None = None
    VAPID_PUBLIC_KEY_B64URL: str | None = None
    VAPID_SUBJECT: str = "mailto:admin@example.com"

    @field_validator("VAPID_PRIVATE_KEY_PEM")
    @classmethod
    def _fix_pem_newlines(cls, v: str | None):
        """
        Railway/CI часто сохраняют PEM как одну строку с буквальными '\\n'.
        PyWebPush ожидает реальный PEM с переносами строк.
        """
        if not v:
            return v
        if "\\n" in v and "\n" not in v:
            v = v.replace("\\n", "\n")
        return v.strip()


settings = Settings()