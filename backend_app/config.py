from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent  # корень проекта (рядом с backend_app)


class Settings(BaseSettings):
    # всегда один и тот же файл БД: <project>/mvp.db
    database_url: str = f"sqlite:///{(BASE_DIR / 'mvp.db').as_posix()}"

    # JWT
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 дней

    # файлы всегда в <project>/storage
    storage_dir: str = str(BASE_DIR / "storage")

    # =========================
    # OpenAI (GPT assistant)
    # =========================

    # ✅ Railway-friendly env aliases:
    # OPENAI_API_KEY / OPENAI_MODEL
    openai_api_key: str = Field(default="", validation_alias="OPENAI_API_KEY")
    openai_model: str = Field(default="gpt-4o-mini", validation_alias="OPENAI_MODEL")

    assistant_system_prompt: str = (
        "Ты помощник в мессенджере. Дай краткую, полезную подсказку/черновик ответа "
        "на сообщение собеседника с учетом контекста. "
        "Не выдумывай факты. Тон — дружелюбный, естественный. "
        "Если недостаточно данных — предложи 1 уточняющий вопрос."
    )

    # лимиты, чтобы не сжечь токены
    assistant_max_messages: int = 14
    assistant_max_message_chars: int = 800
    assistant_max_draft_chars: int = 1200

    # max_output_tokens в ответе модели
    assistant_max_output_tokens: int = 180

    # server-side rate limit (на юзера)
    assistant_min_interval_ms: int = 1500          # не чаще 1.5 сек
    assistant_max_requests_per_minute: int = 20    # на пользователя

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()