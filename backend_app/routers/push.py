from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from pywebpush import webpush, WebPushException

from backend_app.deps import get_db, get_current_user
from backend_app.models import PushSubscription
from backend_app.config import settings

router = APIRouter()


# -------------------------
# VAPID helpers (Railway-safe)
# -------------------------

_PEM_BEGIN_RE = re.compile(r"-----BEGIN [A-Z ]+-----")
_PEM_END_RE = re.compile(r"-----END [A-Z ]+-----")


def _normalize_pem_multiline(s: str) -> str:
    """
    Делает PEM валидным для pywebpush/py_vapid.
    Railway/CI часто кладут PEM в env одной строкой или с '\\n'.
    Поддерживаем:
      - настоящие '\n'
      - '\\n' и '\\r\\n'
      - CRLF
      - PEM в одну строку без переводов
    """
    if not s:
        return s

    x = str(s).strip()

    # 1) Разруливаем экранирование (самое частое на Railway)
    # порядок важен: сначала \\r\\n, потом \\n
    x = x.replace("\\r\\n", "\n").replace("\\n", "\n")
    # 2) Разруливаем реальные CRLF
    x = x.replace("\r\n", "\n").replace("\r", "\n").strip()

    # Если PEM уже выглядит нормально — вернём
    if "-----BEGIN" in x and "\n" in x and "-----END" in x:
        # лёгкая чистка лишних пустых строк
        lines = [ln.strip() for ln in x.split("\n") if ln.strip() != ""]
        return "\n".join(lines) + "\n"

    # Если PEM пришёл одной строкой: BEGIN ... END без \n
    if "-----BEGIN" in x and "-----END" in x and "\n" not in x:
        # Пробуем аккуратно разложить:
        # BEGIN + base64 + END
        # Находим маркеры
        m1 = _PEM_BEGIN_RE.search(x)
        m2 = _PEM_END_RE.search(x)
        if m1 and m2:
            begin = m1.group(0)
            end = m2.group(0)
            # Всё между ними — base64 (возможно с пробелами)
            inner = x[x.find(begin) + len(begin) : x.find(end)]
            inner = inner.strip().replace(" ", "")
            # Разбиваем base64 по 64 символа
            chunks = [inner[i : i + 64] for i in range(0, len(inner), 64) if inner[i : i + 64]]
            lines = [begin] + chunks + [end]
            return "\n".join(lines) + "\n"

    # Если это вообще не PEM (например DER/base64) — оставим как есть,
    # но pywebpush обычно упадёт — и это будет честная ошибка.
    return x


def _get_vapid_private_key() -> str | None:
    key = settings.VAPID_PRIVATE_KEY_PEM
    if not key:
        return None
    return _normalize_pem_multiline(key)


def _get_vapid_public_key() -> str | None:
    # public key должен быть base64url (как в WebPush subscribe)
    pub = settings.VAPID_PUBLIC_KEY_B64URL
    if not pub:
        return None
    return str(pub).strip()


def _require_vapid():
    if not _get_vapid_private_key() or not _get_vapid_public_key():
        raise HTTPException(500, "VAPID keys are not configured on server")


# -------------------------
# Schemas
# -------------------------

class SubKeysIn(BaseModel):
    p256dh: str
    auth: str


class SubscribeIn(BaseModel):
    endpoint: str
    keys: SubKeysIn
    user_agent: str | None = None


# -------------------------
# Routes
# -------------------------

@router.get("/vapid_public_key")
def vapid_public_key():
    _require_vapid()
    return {"publicKey": _get_vapid_public_key()}


@router.post("/subscribe")
def subscribe(data: SubscribeIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    _require_vapid()

    endpoint = (data.endpoint or "").strip()
    if not endpoint:
        raise HTTPException(400, "Missing endpoint")

    p256dh = (data.keys.p256dh or "").strip()
    auth = (data.keys.auth or "").strip()
    if not p256dh or not auth:
        raise HTTPException(400, "Missing subscription keys")

    row = (
        db.query(PushSubscription)
        .filter(PushSubscription.user_id == user.id, PushSubscription.endpoint == endpoint)
        .first()
    )

    now = datetime.utcnow()
    if not row:
        row = PushSubscription(
            user_id=user.id,
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            user_agent=(data.user_agent or "")[:255] or None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.p256dh = p256dh
        row.auth = auth
        row.user_agent = (data.user_agent or "")[:255] or None
        row.updated_at = now

    db.commit()
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(endpoint: str | None = None, db: Session = Depends(get_db), user=Depends(get_current_user)):
    q = db.query(PushSubscription).filter(PushSubscription.user_id == user.id)
    if endpoint:
        q = q.filter(PushSubscription.endpoint == endpoint)

    deleted = q.delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "deleted": int(deleted)}


# -------------------------
# Sender
# -------------------------

def send_webpush_to_user(db: Session, user_id: int, data: dict[str, Any]) -> int:
    """
    Синхронная отправка web push по всем подпискам пользователя.
    Возвращает количество успешных отправок.
    """
    priv = _get_vapid_private_key()
    if not priv:
        return 0

    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    if not subs:
        return 0

    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")

    ok = 0
    to_delete: list[int] = []

    for s in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": s.endpoint,
                    "keys": {"p256dh": s.p256dh, "auth": s.auth},
                },
                data=payload,
                vapid_private_key=priv,
                vapid_claims={"sub": settings.VAPID_SUBJECT},
                ttl=60,
            )
            ok += 1
        except WebPushException as e:
            # Если подписка умерла (410/404) — чистим из БД
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            if status_code in (404, 410):
                to_delete.append(s.id)
        except Exception:
            # Не валим приложение из-за пушей
            pass

    if to_delete:
        db.query(PushSubscription).filter(PushSubscription.id.in_(to_delete)).delete(synchronize_session=False)
        db.commit()

    return ok


@router.post("/test")
def test_push(db: Session = Depends(get_db), user=Depends(get_current_user)):
    _require_vapid()
    sent = send_webpush_to_user(
        db,
        user.id,
        {"type": "test", "title": "Test push", "body": "It works!", "ts": datetime.utcnow().isoformat()},
    )
    return {"ok": True, "sent": int(sent)}