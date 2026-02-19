from pathlib import Path
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

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
