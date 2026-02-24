# backend_app/routers/files.py
import os
from io import BytesIO
from fastapi import APIRouter, Depends, UploadFile, File as UpFile, HTTPException, Query, Header, Form, Request
from fastapi.responses import StreamingResponse, FileResponse
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user
from backend_app.config import settings
from backend_app import models
from backend_app.security import decode_token

router = APIRouter()

ALLOWED_PREFIXES = ("image/", "video/", "audio/", "application/", "text/")


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

    max_bytes = get_max_upload_bytes()

    chunks: list[bytes] = []
    size = 0

    while True:
        chunk = await file.read(1024 * 1024)  # 1MB
        if not chunk:
            break
        size += len(chunk)

        if max_bytes and size > max_bytes:
            raise HTTPException(400, f"File too large (max {max_bytes // (1024*1024)}MB)")

        chunks.append(chunk)

    data = b"".join(chunks)

    rec = models.File(
        owner_id=user.id,
        original_name=file.filename or "file",
        mime=file.content_type,
        size=size,
        data=data,      # ✅ храним bytes в БД
        path=None,      # ✅ на диск не пишем
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)

    return {"file_id": rec.id, "mime": rec.mime, "name": rec.original_name, "size": rec.size}


@router.post("/voice")
async def upload_voice(
    file: UploadFile = UpFile(...),
    duration_ms: int = Form(0),
    waveform: str | None = Form(default=None),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """Upload voice message (audio/webm;codecs=opus recommended)."""
    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(400, "Unsupported voice type")

    max_bytes = get_max_upload_bytes()

    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if max_bytes and size > max_bytes:
            raise HTTPException(400, f"File too large (max {max_bytes // (1024*1024)}MB)")
        chunks.append(chunk)

    data = b"".join(chunks)

    rec = models.File(
        owner_id=user.id,
        original_name=file.filename or "voice.webm",
        mime=file.content_type or "audio/webm",
        size=size,
        data=data,
        path=None,
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)

    meta = models.VoiceMeta(
        file_id=rec.id,
        duration_ms=int(duration_ms or 0),
        waveform_json=waveform,
        codec=(file.content_type or "")[:64],
    )
    db.add(meta)
    db.commit()

    return {"file_id": rec.id, "mime": rec.mime, "name": rec.original_name, "size": rec.size, "duration_ms": meta.duration_ms, "waveform": meta.waveform_json}


def _extract_user_id_from_token(db: Session, token: str) -> int:
    try:
        payload = decode_token(token)
        user_id = int(payload.get("sub")) if isinstance(payload, dict) else int(payload)
    except Exception:
        raise HTTPException(401, "Invalid token")

    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(401, "Invalid token")
    return user.id


def _get_user_id_from_request(
    db: Session,
    token_q: str | None,
    authorization: str | None,
) -> int | None:
    """
    Возвращает user_id если передали токен (query или header),
    иначе None (для публичных аватарок).
    """
    # 1) query token (?token=...)
    if token_q:
        return _extract_user_id_from_token(db, token_q)

    # 2) header Authorization: Bearer ...
    if authorization and authorization.lower().startswith("bearer "):
        t = authorization.split(" ", 1)[1].strip()
        if t:
            return _extract_user_id_from_token(db, t)

    return None


def _is_avatar_file(db: Session, file_id: int) -> bool:
    # если файл используется как аватар у любого юзера — считаем его аватаром
    u = db.query(models.User).filter(models.User.avatar_file_id == file_id).first()
    return u is not None


def user_can_access_file(db: Session, user_id: int, file_id: int) -> bool:
    f = db.get(models.File, file_id)
    if not f:
        return False

    # владелец всегда может
    if f.owner_id == user_id:
        return True

    # ✅ аватар другого пользователя (разрешим видеть всем авторизованным)
    if _is_avatar_file(db, file_id):
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
    request: Request,
    token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    range: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """
    Вариант 1: Authorization: Bearer <token> (fetch/XHR)
    Вариант 2: ?token=... (для <img>/<video>/<a>)
    Вариант 3: БЕЗ токена — только если это АВАТАР (публичная отдача аватарок)
    """

    rec = db.get(models.File, file_id)
    if not rec:
        raise HTTPException(404, "Not found")

    # ✅ ПУБЛИЧНАЯ ОТДАЧА АВАТАРОК:
    # <img> иногда грузится без токена (кэш/переоткрытие/внешний домен).
    # Поэтому если файл является аватаром — отдаем без авторизации.
    if _is_avatar_file(db, file_id):
        return _stream_file(rec, request, range)

    # иначе — нужен токен
    user_id = _get_user_id_from_request(db, token, authorization)
    if user_id is None:
        raise HTTPException(401, "Missing token")

    if not user_can_access_file(db, user_id, file_id):
        raise HTTPException(403, "Forbidden")

    return _stream_file(rec, request, range)


def _stream_file(rec: models.File, request: Request, range_header: str | None):
    """
    Отдаём либо bytes из БД (StreamingResponse),
    либо файл с диска (FileResponse) если вдруг path используется.
    """
    headers = {
        "Content-Disposition": f'inline; filename="{rec.original_name or "file"}"',
        "Cache-Control": "no-store",  # ✅ чтобы аватарки не залипали в кэше
        "Accept-Ranges": "bytes",
    }

    # 1) bytes в БД
    if getattr(rec, "data", None):
        data = rec.data or b""
        total = len(data)

        # Range requests (needed for streaming audio/video)
        if range_header and range_header.startswith("bytes="):
            try:
                spec = range_header.split("=", 1)[1].strip()
                start_s, end_s = (spec.split("-", 1) + [""])[:2]
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else (total - 1)
                if start < 0:
                    start = 0
                if end >= total:
                    end = total - 1
                if end < start:
                    raise ValueError("bad range")
            except Exception:
                # invalid range
                raise HTTPException(416, "Invalid Range")

            chunk = data[start : end + 1]
            headers2 = dict(headers)
            headers2["Content-Range"] = f"bytes {start}-{end}/{total}"
            headers2["Content-Length"] = str(len(chunk))
            return StreamingResponse(BytesIO(chunk), media_type=rec.mime or "application/octet-stream", headers=headers2, status_code=206)

        headers["Content-Length"] = str(total)
        return StreamingResponse(BytesIO(data), media_type=rec.mime or "application/octet-stream", headers=headers)

    # 2) fallback: path на диске
    if getattr(rec, "path", None):
        return FileResponse(
            rec.path,
            media_type=rec.mime or "application/octet-stream",
            filename=rec.original_name or "file",
            headers=headers,
        )

    raise HTTPException(500, "File has no data/path")