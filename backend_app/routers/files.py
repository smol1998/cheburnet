import os
import uuid

from fastapi import APIRouter, Depends, UploadFile, File as UpFile, HTTPException, Query, Header, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user, extract_token
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


def _user_id_from_payload(payload) -> int | None:
    if isinstance(payload, int):
        return payload
    if isinstance(payload, dict):
        sub = payload.get("sub")
        if sub is None:
            return None
        try:
            return int(sub)
        except Exception:
            return None
    return None


def _get_user_from_request(request: Request, db: Session) -> models.User:
    """
    Унифицированная авторизация для /files:
    - Authorization: Bearer <token>
    - или ?token=<token> (для <img>, <video>, <a>)
    """
    token = extract_token(request, request.headers.get("authorization"))
    if not token:
        raise HTTPException(401, "Missing token")
    try:
        payload = decode_token(token)
    except Exception:
        raise HTTPException(401, "Invalid token")

    uid = _user_id_from_payload(payload)
    if not uid:
        raise HTTPException(401, "Invalid token")

    user = db.get(models.User, uid)
    if not user:
        raise HTTPException(401, "Invalid token")
    return user


@router.post("/upload")
async def upload(
    file: UploadFile = UpFile(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    if not file.content_type or not file.content_type.startswith(ALLOWED_PREFIXES):
        raise HTTPException(400, "Unsupported file type")

    max_bytes = get_max_upload_bytes()

    # ✅ Railway Free: сохраняем в Postgres
    data = await file.read()
    size = len(data)

    if max_bytes and size > max_bytes:
        raise HTTPException(400, f"File too large (max {max_bytes // (1024*1024)}MB)")

    rec = models.File(
        owner_id=user.id,
        original_name=file.filename or "file",
        mime=file.content_type,
        size=size,
        path=None,
        data=data,
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

    # разрешим видеть аватар другим авторизованным
    u = db.query(models.User).filter(models.User.avatar_file_id == file_id).first()
    if u is not None:
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


@router.get("/{file_id}")
def download(
    file_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    user = _get_user_from_request(request, db)

    rec = db.get(models.File, file_id)
    if not rec:
        raise HTTPException(404, "Not found")

    if not user_can_access_file(db, user.id, file_id):
        raise HTTPException(403, "Forbidden")

    # ✅ если есть data в БД — отдаём из БД (Railway Free)
    if getattr(rec, "data", None):
        headers = {
            # чтобы браузер мог показывать img/video inline
            "Content-Disposition": f'inline; filename="{rec.original_name}"'
        }
        return Response(content=rec.data, media_type=rec.mime, headers=headers)

    # fallback: старый режим (если у тебя где-то всё же есть диск)
    if rec.path and os.path.exists(rec.path):
        return FileResponse(rec.path, media_type=rec.mime, filename=rec.original_name)

    raise HTTPException(404, "File content missing")
