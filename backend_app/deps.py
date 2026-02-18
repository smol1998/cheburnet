from typing import Generator

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from backend_app.db import SessionLocal
from backend_app.security import decode_token
from backend_app import models

bearer = HTTPBearer(auto_error=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> models.User:
    if not creds or creds.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated")

    try:
        payload = decode_token(creds.credentials)
        user_id = int(payload["sub"])
    except Exception:
        raise HTTPException(401, "Invalid token")

    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(401, "User not found")

    return user
