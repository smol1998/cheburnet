from datetime import datetime, timedelta, timezone
from jose import jwt
from passlib.context import CryptContext

from backend_app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(password: str) -> str:
    # bcrypt ограничение 72 байта — режем
    return pwd_context.hash(password.encode("utf-8")[:72].decode("utf-8", "ignore"))

def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password.encode("utf-8")[:72].decode("utf-8", "ignore"), password_hash)

def create_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_expire_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

def decode_token(token: str):
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
