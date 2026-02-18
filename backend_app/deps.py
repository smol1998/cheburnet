from typing import Generator, Optional, Any

from fastapi import Depends, HTTPException, Header, Request
from sqlalchemy.orm import Session

from backend_app.db import SessionLocal
from backend_app import models
from backend_app.security import decode_token


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _extract_bearer_token(request: Request, authorization: Optional[str]) -> Optional[str]:
    """
    1) Standard: Authorization: Bearer <token>
    2) Fallback for <img>/<video>/<a download>: /files/{id}?token=<token>
    """
    if authorization:
        parts = authorization.split(" ", 1)
        if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
            return parts[1].strip()

    # fallback: query param
    t = request.query_params.get("token")
    if t and t.strip():
        return t.strip()

    return None


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    authorization: Optional[str] = Header(default=None),
) -> models.User:
    token = _extract_bearer_token(request, authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    payload: Any
    try:
        payload = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    # decode_token может возвращать:
    # - int user_id
    # - dict {"sub": "..."}
    user_id: Optional[int] = None
    if isinstance(payload, int):
        user_id = payload
    elif isinstance(payload, dict):
        sub = payload.get("sub")
        if sub is not None:
            try:
                user_id = int(sub)
            except Exception:
                user_id = None

    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user
