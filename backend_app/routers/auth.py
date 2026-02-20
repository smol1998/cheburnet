from fastapi import APIRouter, Depends, HTTPException, UploadFile, File as UpFile, Form, Header, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend_app.db import SessionLocal
from backend_app import models
from backend_app.security import hash_password, verify_password, create_access_token, decode_token

router = APIRouter()

ALLOWED_AVATAR_PREFIXES = ("image/",)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


async def read_upload_bytes(upload: UploadFile, max_bytes: int) -> bytes:
    """Читаем UploadFile в память с ограничением по размеру."""
    size = 0
    buf = bytearray()
    while True:
        chunk = await upload.read(1024 * 1024)  # 1MB
        if not chunk:
            break
        size += len(chunk)
        if size > max_bytes:
            raise HTTPException(400, f"Avatar too large (max {max_bytes // (1024*1024)}MB)")
        buf.extend(chunk)
    return bytes(buf)


# --------- Pydantic схемы для JSON ---------
class RegisterIn(BaseModel):
    username: str
    password: str


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/register")
def register(data: RegisterIn, db: Session = Depends(get_db)):
    username = (data.username or "").strip()
    password = (data.password or "").strip()

    if not username or not password:
        raise HTTPException(400, "Username and password required")

    if db.query(models.User).filter(models.User.username == username).first():
        raise HTTPException(400, "Username already exists")

    u = models.User(username=username, password_hash=hash_password(password))
    db.add(u)
    db.commit()
    db.refresh(u)

    return {"id": u.id, "username": u.username}


@router.post("/register_form")
async def register_form(
    username: str = Form(...),
    password: str = Form(...),
    birth_year: int | None = Form(default=None),
    avatar: UploadFile | None = UpFile(default=None),
    db: Session = Depends(get_db),
):
    username = (username or "").strip()
    password = (password or "").strip()

    if not username or not password:
        raise HTTPException(400, "Username and password required")

    if db.query(models.User).filter(models.User.username == username).first():
        raise HTTPException(400, "Username already exists")

    u = models.User(
        username=username,
        password_hash=hash_password(password),
        birth_year=birth_year,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    avatar_file_id = None
    if avatar is not None:
        if not avatar.content_type or not avatar.content_type.startswith(ALLOWED_AVATAR_PREFIXES):
            raise HTTPException(400, "Avatar must be image/*")

        data_bytes = await read_upload_bytes(avatar, max_bytes=5 * 1024 * 1024)

        rec = models.File(
            owner_id=u.id,
            original_name=avatar.filename or "avatar",
            mime=avatar.content_type or "application/octet-stream",
            size=len(data_bytes),
            data=data_bytes,
            path=None,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)

        avatar_file_id = rec.id
        u.avatar_file_id = avatar_file_id
        db.add(u)
        db.commit()
        db.refresh(u)

    token = create_access_token({"sub": str(u.id)})

    return {
        "id": u.id,
        "username": u.username,
        "access_token": token,
        "avatar_file_id": avatar_file_id,
        "avatar_url": (f"/files/{avatar_file_id}" if avatar_file_id else None),
    }


@router.post("/login")
def login(data: LoginIn, db: Session = Depends(get_db)):
    username = (data.username or "").strip()
    password = (data.password or "").strip()

    u = db.query(models.User).filter(models.User.username == username).first()
    if not u or not verify_password(password, u.password_hash):
        raise HTTPException(401, "Invalid credentials")

    token = create_access_token({"sub": str(u.id)})
    return {"access_token": token, "token_type": "bearer"}


def _extract_token(token_q: str | None, authorization: str | None) -> str:
    """
    Поддержка двух способов:
    - Authorization: Bearer <token>  (обычно fetch)
    - ?token=<token>                (иногда удобно)
    """
    if token_q:
        return token_q

    if not authorization:
        raise HTTPException(401, "Missing token")

    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Invalid Authorization header")

    return authorization.split(" ", 1)[1].strip()


@router.get("/me")
def me(
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    t = _extract_token(token, authorization)

    try:
        payload = decode_token(t)
        user_id = int(payload.get("sub")) if isinstance(payload, dict) else int(payload)
    except Exception:
        raise HTTPException(401, "Invalid token")

    u = db.get(models.User, user_id)
    if not u:
        raise HTTPException(401, "User not found")

    avatar_file_id = getattr(u, "avatar_file_id", None)
    return {
        "id": u.id,
        "username": u.username,
        "birth_year": u.birth_year,
        "avatar_file_id": avatar_file_id,
        "avatar_url": (f"/files/{avatar_file_id}" if avatar_file_id else None),
    }


# ✅ NEW: обновление профиля (год рождения + аватар)
@router.post("/profile_update_form")
async def profile_update_form(
    birth_year: int | None = Form(default=None),
    avatar: UploadFile | None = UpFile(default=None),
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    t = _extract_token(token, authorization)

    try:
        payload = decode_token(t)
        user_id = int(payload.get("sub")) if isinstance(payload, dict) else int(payload)
    except Exception:
        raise HTTPException(401, "Invalid token")

    u = db.get(models.User, user_id)
    if not u:
        raise HTTPException(401, "User not found")

    # birth_year (если прислали)
    if birth_year is not None:
        u.birth_year = birth_year

    # avatar (если прислали)
    if avatar is not None:
        if not avatar.content_type or not avatar.content_type.startswith(ALLOWED_AVATAR_PREFIXES):
            raise HTTPException(400, "Avatar must be image/*")

        data_bytes = await read_upload_bytes(avatar, max_bytes=5 * 1024 * 1024)

        rec = models.File(
            owner_id=u.id,
            original_name=avatar.filename or "avatar",
            mime=avatar.content_type or "application/octet-stream",
            size=len(data_bytes),
            data=data_bytes,
            path=None,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)

        u.avatar_file_id = rec.id

    db.add(u)
    db.commit()
    db.refresh(u)

    avatar_file_id = getattr(u, "avatar_file_id", None)
    return {
        "id": u.id,
        "username": u.username,
        "birth_year": u.birth_year,
        "avatar_file_id": avatar_file_id,
        "avatar_url": (f"/files/{avatar_file_id}" if avatar_file_id else None),
    }