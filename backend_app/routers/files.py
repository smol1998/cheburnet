import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, UploadFile, File as UpFile, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user
from backend_app.config import settings
from backend_app import models
from backend_app.security import decode_token

router = APIRouter()

ALLOWED_PREFIXES = ("image/", "video/", "application/", "text/")


@router.post("/upload")
async def upload(
    file: UploadFile = UpFile(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    if not file.content_type or not file.content_type.startswith(ALLOWED_PREFIXES):
        raise HTTPException(400, "Unsupported file type")

    os.makedirs(settings.storage_dir, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1]
    name = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.storage_dir, name)

    size = 0
    with open(path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > 50 * 1024 * 1024:
                f.close()
                try:
                    os.remove(path)
                except Exception:
                    pass
                raise HTTPException(400, "File too large (max 50MB)")
            f.write(chunk)

    rec = models.File(
        owner_id=user.id,
        original_name=file.filename or name,
        mime=file.content_type,
        size=size,
        path=path,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)

    return {"file_id": rec.id, "mime": rec.mime, "name": rec.original_name, "size": rec.size}


def user_can_access_file(db: Session, user_id: int, file_id: int) -> bool:
    f = db.get(models.File, file_id)
    if not f:
        return False
    if f.owner_id == user_id:
        return True

    q = (
        db.query(models.DMChat.id)
        .join(models.Message, models.Message.chat_id == models.DMChat.id)
        .join(models.MessageAttachment, models.MessageAttachment.message_id == models.Message.id)
        .filter(models.MessageAttachment.file_id == file_id)
        .filter((models.DMChat.user1_id == user_id) | (models.DMChat.user2_id == user_id))
        .limit(1)
    )
    return db.query(q.exists()).scalar() is True


def _get_user_from_token(db: Session, token: str):
    """
    Для медиа (<img>/<video>) браузер НЕ отправляет Authorization header.
    Поэтому /files/{id} поддерживает ?token=... и обычный Bearer.
    """
    try:
        payload = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

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


@router.get("/{file_id}")
def download(
    file_id: int,
    request: Request,
    token: Optional[str] = None,
    db: Session = Depends(get_db),
):
    rec = db.get(models.File, file_id)
    if not rec:
        raise HTTPException(404, "Not found")

    # 1) если передали ?token=...
    if token:
        user = _get_user_from_token(db, token)
    else:
        # 2) иначе берем из Authorization: Bearer ...
        auth = request.headers.get("authorization") or ""
        if not auth.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="Not authenticated")
        bearer = auth.split(" ", 1)[1].strip()
        user = _get_user_from_token(db, bearer)

    if not user_can_access_file(db, user.id, file_id):
        raise HTTPException(403, "Forbidden")

    return FileResponse(rec.path, media_type=rec.mime, filename=rec.original_name)
