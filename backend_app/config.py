from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        case_sensitive=True,
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
    # Можешь положить сюда:
    # - PEM
    # - base64(PEM)
    # - base64url(PEM)
    # - base64/base64url(DER)
    VAPID_PRIVATE_KEY_PEM_B64: str | None = None

    # В браузер отдаём public key (base64url)
    VAPID_PUBLIC_KEY_B64URL: str | None = None

    # Типа mailto:admin@example.com
    VAPID_SUBJECT: str = "mailto:admin@example.com"

    @field_validator("VAPID_PRIVATE_KEY_PEM_B64", mode="before")
    @classmethod
    def _vapid_priv_loose_norm(cls, v: Any) -> Any:
        if v is None:
            return None
        if not isinstance(v, str):
            v = str(v)
        # не уничтожаем PEM, просто убираем пробелы по краям
        return v.strip() or None

    @field_validator("VAPID_PUBLIC_KEY_B64URL", mode="before")
    @classmethod
    def _vapid_pub_norm(cls, v: Any) -> Any:
        if v is None:
            return None
        if not isinstance(v, str):
            v = str(v)
        return v.strip() or None


settings = Settings()