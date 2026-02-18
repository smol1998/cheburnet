from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Railway обычно даёт DATABASE_URL
    database_url: str = "sqlite:///./mvp.db"

    # JWT
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 дней

    # Для файлов (если нужно)
    storage_dir: str = "storage"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
