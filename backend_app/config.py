from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

BASE_DIR = Path(__file__).resolve().parent.parent


def _norm_multiline_env(v: Any) -> Any:
    """
    Railway/ENV часто хранит PEM либо:
    - реальными переносами строк
    - либо в одну строку с символами \\n
    Это нормализует всё к нормальному PEM.
    """
    if v is None:
        return None
    if not isinstance(v, str):
        v = str(v)

    s = v.strip()
    s = s.replace("\\r\\n", "\n").replace("\\n", "\n")
    return s


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
    # Можно хранить:
    # - PEM напрямую (multiline)
    # - либо base64/base64url(PEM) одной строкой
    VAPID_PRIVATE_KEY_PEM_B64: str | None = None
    VAPID_PUBLIC_KEY_B64URL: str | None = None
    VAPID_SUBJECT: str = "mailto:admin@example.com"

    @field_validator("VAPID_PRIVATE_KEY_PEM_B64", mode="before")
    @classmethod
    def _vapid_priv_b64_norm(cls, v: Any) -> Any:
        """
        Если это PEM (с -----BEGIN/-----END) — НЕ вырезаем пробелы/переносы,
        иначе ломается заголовок "PRIVATE KEY" -> "PRIVATEKEY".
        Только нормализуем экранированные \\n.

        Если это base64/base64url — ужимаем в одну строку (без пробелов/переносов).
        """
        if v is None:
            return None
        if not isinstance(v, str):
            v = str(v)
        s = v.strip()

        # ✅ PEM напрямую — сохраняем формат
        if "-----BEGIN" in s and "-----END" in s:
            return _norm_multiline_env(s)

        # ✅ иначе base64/base64url — ужимаем
        s = s.replace("\\r\\n", "").replace("\\n", "")
        s = s.replace("\r", "").replace("\n", "")
        s = "".join(s.split())
        return s or None

    @field_validator("VAPID_PUBLIC_KEY_B64URL", mode="before")
    @classmethod
    def _vapid_pub_norm(cls, v: Any) -> Any:
        if v is None:
            return None
        if not isinstance(v, str):
            v = str(v)
        return v.strip()


settings = Settings()