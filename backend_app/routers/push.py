from __future__ import annotations

import json
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


def _require_vapid():
    if not settings.VAPID_PRIVATE_KEY_PEM or not settings.VAPID_PUBLIC_KEY_B64URL:
        raise HTTPException(500, "VAPID keys are not configured on server")


class SubKeysIn(BaseModel):
    p256dh: str
    auth: str


class SubscribeIn(BaseModel):
    endpoint: str
    keys: SubKeysIn
    user_agent: str | None = None


@router.get("/vapid_public_key")
def vapid_public_key():
    _require_vapid()
    return {"publicKey": settings.VAPID_PUBLIC_KEY_B64URL}


@router.post("/subscribe")
def subscribe(data: SubscribeIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    _require_vapid()

    endpoint = (data.endpoint or "").strip()
    if not endpoint:
        raise HTTPException(400, "Missing endpoint")

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
            p256dh=data.keys.p256dh.strip(),
            auth=data.keys.auth.strip(),
            user_agent=(data.user_agent or "")[:255] or None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.p256dh = data.keys.p256dh.strip()
        row.auth = data.keys.auth.strip()
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


def send_webpush_to_user(db: Session, user_id: int, data: dict[str, Any]) -> int:
    """
    Синхронная отправка web push по всем подпискам пользователя.
    Возвращает количество успешных отправок.
    """
    if not settings.VAPID_PRIVATE_KEY_PEM:
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
                vapid_private_key=settings.VAPID_PRIVATE_KEY_PEM,
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
            # не валим приложение из-за пушей
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