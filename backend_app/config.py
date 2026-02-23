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
    # 1) В Railway можешь хранить либо:
    #    - base64 от PEM (одной строкой) -> VAPID_PRIVATE_KEY_PEM_B64
    #    - ИЛИ PEM напрямую (многострочный) -> тоже переживём (push.py сам определит)
    VAPID_PRIVATE_KEY_PEM_B64: str | None = None
    VAPID_PUBLIC_KEY_B64URL: str | None = None
    VAPID_SUBJECT: str = "mailto:admin@example.com"

    @field_validator("VAPID_PRIVATE_KEY_PEM_B64", mode="before")
    @classmethod
    def _vapid_priv_norm(cls, v: Any) -> Any:
        if v is None:
            return None
        if not isinstance(v, str):
            v = str(v)

        s = v.strip()

        # ВАЖНО:
        # - если это base64 PEM: убираем все пробелы/переносы
        # - если это PEM напрямую: там есть '-----BEGIN', тогда НЕЛЬЗЯ вырезать переводы строк
        if "-----BEGIN" in s and "-----END" in s:
            # оставляем как есть, только нормализуем \n
            s = s.replace("\\r\\n", "\n").replace("\\n", "\n")
            s = s.replace("\r\n", "\n").replace("\r", "\n").strip()
            return s or None

        # иначе считаем это B64/B64URL и “ужимаем” до одной строки
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
        return v.strip() or None


settings = Settings()