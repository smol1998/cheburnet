from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

BASE_DIR = Path(__file__).resolve().parent.parent


def _as_str(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v
    return str(v)


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
    # Мы допускаем, что в Railway тут может быть:
    # - PEM (с переносами / с \n / в одну строку)
    # - base64(PEM)
    # - base64url(PEM)
    # - DER в base64/base64url
    VAPID_PRIVATE_KEY_PEM_B64: str | None = None
    VAPID_PUBLIC_KEY_B64URL: str | None = None
    VAPID_SUBJECT: str = "mailto:admin@example.com"

    @field_validator("VAPID_PRIVATE_KEY_PEM_B64", mode="before")
    @classmethod
    def _vapid_priv_keep_rawish(cls, v: Any) -> Any:
        s = _as_str(v)
        if s is None:
            return None
        # убираем только внешние пробелы; внутри не трогаем,
        # потому что нормализация будет в push.py
        return s.strip() or None

    @field_validator("VAPID_PUBLIC_KEY_B64URL", mode="before")
    @classmethod
    def _vapid_pub_norm(cls, v: Any) -> Any:
        s = _as_str(v)
        if s is None:
            return None
        return s.strip() or None


settings = Settings()