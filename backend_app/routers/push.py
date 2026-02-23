from __future__ import annotations

import base64
import binascii
import json
import logging
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
log = logging.getLogger("push")


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
    x = x.replace("\\r\\n", "\n").replace("\\n", "\n")
    # 2) Разруливаем реальные CRLF
    x = x.replace("\r\n", "\n").replace("\r", "\n").strip()

    # Если PEM уже выглядит нормально — вернём
    if "-----BEGIN" in x and "\n" in x and "-----END" in x:
        lines = [ln.strip() for ln in x.split("\n") if ln.strip() != ""]
        return "\n".join(lines) + "\n"

    # Если PEM пришёл одной строкой: BEGIN ... END без \n
    if "-----BEGIN" in x and "-----END" in x and "\n" not in x:
        m1 = _PEM_BEGIN_RE.search(x)
        m2 = _PEM_END_RE.search(x)
        if m1 and m2:
            begin = m1.group(0)
            end = m2.group(0)
            inner = x[x.find(begin) + len(begin) : x.find(end)]
            inner = inner.strip().replace(" ", "")
            chunks = [inner[i : i + 64] for i in range(0, len(inner), 64) if inner[i : i + 64]]
            lines = [begin] + chunks + [end]
            return "\n".join(lines) + "\n"

    return x


def _b64_to_text(b64: str) -> str:
    """
    Декодирует base64/base64url в текст.
    Терпимо к отсутствию padding (=).
    """
    s = "".join(str(b64).strip().split())

    # base64url -> base64
    s = s.replace("-", "+").replace("_", "/")

    pad = (-len(s)) % 4
    if pad:
        s += "=" * pad

    raw = base64.b64decode(s, validate=False)
    return raw.decode("utf-8", errors="strict")


def _get_vapid_private_key() -> str | None:
    """
    Ожидаем settings.VAPID_PRIVATE_KEY_PEM_B64:
      - base64/base64url(PEM)
    Возвращаем нормализованный PEM.
    """
    key_b64 = settings.VAPID_PRIVATE_KEY_PEM_B64
    if not key_b64:
        return None

    s = str(key_b64).strip()

    # Если вдруг кто-то положил PEM напрямую — тоже переживём
    if "-----BEGIN" in s and "-----END" in s:
        pem = _normalize_pem_multiline(s)
        if "-----BEGIN" not in pem or "-----END" not in pem:
            log.error("VAPID key looks like PEM but normalization failed")
            return None
        return pem

    # Иначе считаем, что это base64/base64url от PEM
    try:
        pem_text = _b64_to_text(s)
    except (binascii.Error, UnicodeDecodeError, ValueError) as e:
        log.error("VAPID_PRIVATE_KEY_PEM_B64 decode failed: %s", e)
        return None

    pem = _normalize_pem_multiline(pem_text)

    # финальная проверка
    if "-----BEGIN" not in pem or "-----END" not in pem:
        log.error("Decoded VAPID private key does not look like PEM")
        return None

    return pem


def _get_vapid_public_key() -> str | None:
    pub = settings.VAPID_PUBLIC_KEY_B64URL
    if not pub:
        return None
    return str(pub).strip()


def _require_vapid():
    if not _get_vapid_private_key() or not _get_vapid_public_key():
        raise HTTPException(500, "VAPID keys are not configured on server")


def _to_base64url(s: str) -> str:
    """
    Приводим subscription keys к base64url без '='.
    Частая проблема: фронт (fallback) шлёт обычный base64 с +/ и padding '='.
    pywebpush обычно ожидает base64url.
    """
    x = (s or "").strip()
    if not x:
        return x
    x = "".join(x.split())
    x = x.replace("+", "-").replace("/", "_")
    x = x.rstrip("=")
    return x


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

    # ✅ нормализуем (base64url) ещё на входе
    p256dh = _to_base64url(data.keys.p256dh or "")
    auth = _to_base64url(data.keys.auth or "")
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

def send_webpush_to_user(db: Session, user_id: int, data: dict[str, Any]) -> dict[str, Any]:
    """
    Синхронная отправка web push по всем подпискам пользователя.
    Возвращает детали, чтобы понимать, почему sent=0.
    """
    priv = _get_vapid_private_key()
    if not priv:
        return {"sent": 0, "total": 0, "reason": "no_private_key"}

    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    if not subs:
        return {"sent": 0, "total": 0, "reason": "no_subscriptions"}

    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")

    ok = 0
    to_delete: list[int] = []
    errors: list[dict[str, Any]] = []

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
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            body = getattr(getattr(e, "response", None), "text", None)
            err = {
                "endpoint": s.endpoint[:120],
                "status_code": status_code,
                "error": str(e),
                "response_text": body[:300] if isinstance(body, str) else None,
            }
            errors.append(err)
            log.warning("WebPushException: %s", err)

            if status_code in (404, 410):
                to_delete.append(s.id)
        except Exception as e:
            err = {"endpoint": s.endpoint[:120], "error": repr(e)}
            errors.append(err)
            log.exception("Webpush failed: %s", err)

    if to_delete:
        db.query(PushSubscription).filter(PushSubscription.id.in_(to_delete)).delete(synchronize_session=False)
        db.commit()

    return {"sent": ok, "total": len(subs), "deleted": len(to_delete), "errors": errors[:5]}


@router.post("/test")
def test_push(db: Session = Depends(get_db), user=Depends(get_current_user)):
    _require_vapid()
    res = send_webpush_to_user(
        db,
        user.id,
        {"type": "test", "title": "Test push", "body": "It works!", "ts": datetime.utcnow().isoformat()},
    )
    return {"ok": True, **res}