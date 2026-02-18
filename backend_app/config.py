from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # JWT
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 days

    # DB (SQLite file in backend/ folder)
    database_url: str = "sqlite:///./mvp.db"

    # Files storage
    storage_dir: str = "./storage"

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
