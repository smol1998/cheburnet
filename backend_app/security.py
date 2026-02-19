from datetime import datetime, timedelta
from typing import Any

from jose import jwt
from passlib.context import CryptContext

from backend_app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _bcrypt_safe_password(password: str) -> str:
    """
    bcrypt ограничивает пароль 72 БАЙТА.
    Если резать строку "по символам" или decode(ignore) — можно случайно получить >72 байт.
    Поэтому режем именно байты и декодируем обратно строго.
    """
    b = (password or "").encode("utf-8")
    if len(b) <= 72:
        return password or ""

    cut = b[:72]
    # Важно: не оставлять "обрезанный" UTF-8 символ в конце
    while True:
        try:
            return cut.decode("utf-8")
        except UnicodeDecodeError:
            cut = cut[:-1]
            if not cut:
                return ""


def hash_password(password: str) -> str:
    pw = _bcrypt_safe_password(password)
    return pwd_context.hash(pw)


def verify_password(password: str, password_hash: str) -> bool:
    pw = _bcrypt_safe_password(password)
    return pwd_context.verify(pw, password_hash)


def create_token(user_id: int) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> Any:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
