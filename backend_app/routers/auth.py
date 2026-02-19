import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File as UpFile, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user
from backend_app import models
from backend_app.security import hash_password, verify_password, create_token
from backend_app.config import settings

router = APIRouter()
MAX_BCRYPT_BYTES = 72
ALLOWED_AVATAR_PREFIXES = ("image/",)


class AuthIn(BaseModel):
    username: str
    password: str


def ensure_bcrypt_len(password: str) -> None:
    if len(password.encode("utf-8")) > MAX_BCRYPT_BYTES:
        raise HTTPException(
            status_code=400,
            detail="Password too long (max 72 bytes for bcrypt). Use <= 72 bytes."
        )


def save_upload(upload: UploadFile) -> tuple[str, int]:
    os.makedirs(settings.storage_dir, exist_ok=True)
    ext = os.path.splitext(upload.filename or "")[1]
    name = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.storage_dir, name)

    size = 0
    with open(path, "wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            f.write(chunk)
    return path, size


@router.post("/register")
def register(data: AuthIn, db: Session = Depends(get_db)):
    username = data.username.strip()
    password = data.password.strip()

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username/password required")

    ensure_bcrypt_len(password)

    if db.query(models.User).filter_by(username=username).first():
        raise HTTPException(status_code=400, detail="Username already exists")

    u = models.User(username=username, password_hash=hash_password(password))
    db.add(u)
    db.commit()
    db.refresh(u)

    return {"id": u.id, "username": u.username}


@router.post("/register_form")
def register_form(
    username: str = Form(...),
    password: str = Form(...),
    birth_year: int | None = Form(default=None),
    avatar: UploadFile | None = UpFile(default=None),
    db: Session = Depends(get_db),
):
    username = (username or "").strip()
    password = (password or "").strip()

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username/password required")

    ensure_bcrypt_len(password)

    if db.query(models.User).filter_by(username=username).first():
        raise HTTPException(status_code=400, detail="Username already exists")

    # 1) создаём пользователя сначала (без аватара)
    u = models.User(
        username=username,
        password_hash=hash_password(password),
    )

    # birth_year может не быть в модели (на случай старой БД) — проверяем hasattr
    if hasattr(models.User, "birth_year"):
        u.birth_year = birth_year

    db.add(u)
    db.commit()
    db.refresh(u)

    # 2) сохраняем аватар и пишем в files с owner_id=u.id
    avatar_file_id = None
    if avatar is not None:
        if not avatar.content_type or not avatar.content_type.startswith(ALLOWED_AVATAR_PREFIXES):
            raise HTTPException(400, "Avatar must be image/*")

        path, size = save_upload(avatar)

        rec = models.File(
            owner_id=u.id,
            original_name=avatar.filename or os.path.basename(path),
            mime=avatar.content_type,
            size=size,
            path=path,
        )
        db.add(rec)
        db.commit()
        db.refresh(rec)
        avatar_file_id = rec.id

        # avatar_file_id тоже может не быть в модели (на случай старой БД)
        if hasattr(models.User, "avatar_file_id"):
            u.avatar_file_id = avatar_file_id
            db.commit()
            db.refresh(u)

    return {
        "id": u.id,
        "username": u.username,
        "birth_year": getattr(u, "birth_year", None),
        "avatar_file_id": getattr(u, "avatar_file_id", None),
        "avatar_url": (f"/files/{u.avatar_file_id}" if getattr(u, "avatar_file_id", None) else None),
    }


@router.post("/login")
def login(data: AuthIn, db: Session = Depends(get_db)):
    username = data.username.strip()
    password = data.password.strip()

    ensure_bcrypt_len(password)

    u = db.query(models.User).filter_by(username=username).first()
    if not u or not verify_password(password, u.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    return {"access_token": create_token(u.id)}


@router.get("/me")
def me(user=Depends(get_current_user)):
    # абсолютно безопасно — не упадёт даже если колонок нет
    return {
        "id": user.id,
        "username": user.username,
        "birth_year": getattr(user, "birth_year", None),
        "avatar_file_id": getattr(user, "avatar_file_id", None),
        "avatar_url": (f"/files/{getattr(user, 'avatar_file_id', None)}" if getattr(user, "avatar_file_id", None) else None),
    }
