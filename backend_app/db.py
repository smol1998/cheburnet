import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./mvp.db")

# Railway fix: psycopg2 driver
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace(
        "postgresql://",
        "postgresql+psycopg2://",
        1
    )

connect_args = {}
engine_kwargs = {
    "pool_pre_ping": True,
    "pool_recycle": 300,   # ✅ ВАЖНО для Railway (фикс ws closed и idle disconnect)
}

# SQLite fix
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
    engine_kwargs["connect_args"] = connect_args

engine = create_engine(
    DATABASE_URL,
    **engine_kwargs
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)
