import os
import uuid
from fastapi import APIRouter, Depends, UploadFile, File as UpFile, HTTPException, Query, Header
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user
from backend_app.config import settings
from backend_app import models
from backend_app.security import decode_token

router = APIRouter()

ALLOWED_PREFIXES = ("image/", "video/", "application/", "text/")


def get_max_upload_bytes() -> int:
    mb = getattr(settings, "max_upload_mb", None)
    if mb is None:
        mb = int(os.getenv("MAX_UPLOAD_MB", "0"))
    if not mb or mb <= 0:
        return 0
    return mb * 1024 * 1024


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

    max_bytes = get_max_upload_bytes()

    size = 0
    with open(path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)  # 1MB
            if not chunk:
                break
            size += len(chunk)

            if max_bytes and size > max_bytes:
                f.close()
                try:
                    os.remove(path)
                except Exception:
                    pass
                raise HTTPException(400, f"File too large (max {max_bytes // (1024*1024)}MB)")

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

    # владелец всегда может
    if f.owner_id == user_id:
        return True

    # аватар другого пользователя (разрешим видеть всем авторизованным)
    # (если хочешь приватно — убери этот блок)
    u = db.query(models.User).filter(models.User.avatar_file_id == file_id).first()
    if u is not None:
        return True

    # иначе проверяем, прикреплён ли файл в чате, где участвует user
    q = (
        db.query(models.DMChat.id)
        .join(models.Message, models.Message.chat_id == models.DMChat.id)
        .join(models.MessageAttachment, models.MessageAttachment.message_id == models.Message.id)
        .filter(models.MessageAttachment.file_id == file_id)
        .filter((models.DMChat.user1_id == user_id) | (models.DMChat.user2_id == user_id))
        .limit(1)
    )
    return db.query(q.exists()).scalar() is True


@router.get("/{file_id}")
def download(
    file_id: int,
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """
    Вариант 1: Authorization: Bearer <token> (fetch/XHR)
    Вариант 2: ?token=... (для <img>/<video>/<a>)
    """
    # 1) авторизация через query token
    user = None
    if token:
        try:
            payload = decode_token(token)
            user_id = int(payload.get("sub"))
        except Exception:
            raise HTTPException(401, "Invalid token")
        user = db.get(models.User, user_id)
        if not user:
            raise HTTPException(401, "Invalid token")

    # 2) авторизация через header
    if user is None:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing token")
        t = authorization.split(" ", 1)[1].strip()
        try:
            payload = decode_token(t)
            user_id = int(payload.get("sub"))
        except Exception:
            raise HTTPException(401, "Invalid token")
        user = db.get(models.User, user_id)
        if not user:
            raise HTTPException(401, "Invalid token")

    rec = db.get(models.File, file_id)
    if not rec:
        raise HTTPException(404, "Not found")

    if not user_can_access_file(db, user.id, file_id):
        raise HTTPException(403, "Forbidden")

    return FileResponse(rec.path, media_type=rec.mime, filename=rec.original_name)
