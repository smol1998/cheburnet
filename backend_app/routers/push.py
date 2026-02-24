from __future__ import annotations

import base64
import binascii
import json
import logging
import os
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


# ============================================================
# VAPID KEY HANDLING
# ============================================================

_PEM_BEGIN_RE = re.compile(r"-----BEGIN [A-Z0-9 ]+-----")
_PEM_END_RE = re.compile(r"-----END [A-Z0-9 ]+-----")

_VAPID_PEM_CACHE_PATH = "/tmp/vapid_private.pem"
_VAPID_PEM_CACHE_RAW_FINGERPRINT = None


def _strip_ws(s: str) -> str:
    return "".join((s or "").split())


def _b64_any_to_bytes(s: str) -> bytes:

    x = _strip_ws(s)

    if not x:
        return b""

    x = x.replace("-", "+").replace("_", "/")

    pad = (-len(x)) % 4

    if pad:
        x += "=" * pad

    return base64.b64decode(x, validate=False)


def _chunk64(s: str) -> str:

    return "\n".join(
        s[i : i + 64]
        for i in range(0, len(s), 64)
        if s[i : i + 64]
    )


def _normalize_pem(pem: str) -> str:

    x = (pem or "").strip()

    if not x:
        return ""

    x = x.replace("\\n", "\n")

    x = x.replace("\r\n", "\n")

    x = x.replace("\r", "\n")

    if "-----BEGIN" in x and "-----END" in x and "\n" in x:

        lines = [
            ln.strip()
            for ln in x.split("\n")
            if ln.strip()
        ]

        return "\n".join(lines) + "\n"

    if "-----BEGIN" in x and "-----END" in x:

        m1 = _PEM_BEGIN_RE.search(x)
        m2 = _PEM_END_RE.search(x)

        if m1 and m2:

            begin = m1.group(0)
            end = m2.group(0)

            inner = (
                x[x.find(begin) + len(begin) : x.find(end)]
                .strip()
                .replace(" ", "")
            )

            return (
                begin
                + "\n"
                + _chunk64(inner)
                + "\n"
                + end
                + "\n"
            )

    return x


def _ensure_vapid_pem_file() -> str | None:

    global _VAPID_PEM_CACHE_RAW_FINGERPRINT

    raw = settings.VAPID_PRIVATE_KEY_PEM_B64

    if not raw:
        return None

    fp = str(hash(raw))

    if (
        _VAPID_PEM_CACHE_RAW_FINGERPRINT == fp
        and os.path.exists(_VAPID_PEM_CACHE_PATH)
    ):
        return _VAPID_PEM_CACHE_PATH

    try:

        if "-----BEGIN" in raw:
            pem = _normalize_pem(raw)

        else:
            pem = _normalize_pem(
                _b64_any_to_bytes(raw).decode("utf-8")
            )

    except Exception as e:

        log.error("VAPID key invalid: %s", e)

        return None

    with open(
        _VAPID_PEM_CACHE_PATH,
        "w",
        encoding="utf-8",
        newline="\n",
    ) as f:

        f.write(pem)

    _VAPID_PEM_CACHE_RAW_FINGERPRINT = fp

    return _VAPID_PEM_CACHE_PATH


def _get_vapid_public_key() -> str | None:

    return settings.VAPID_PUBLIC_KEY_B64URL


def _require_vapid():

    if not _ensure_vapid_pem_file():
        raise HTTPException(
            500,
            "VAPID private key missing",
        )

    if not _get_vapid_public_key():
        raise HTTPException(
            500,
            "VAPID public key missing",
        )


# ============================================================
# AVATAR + USER DISPLAY HELPERS
# ============================================================

def make_sender_display(username: str | None) -> str:

    u = (username or "").strip()

    if not u:
        return "Новое сообщение"

    if u.startswith("@"):
        return u

    return "@" + u


def make_avatar_icon_url(
    *,
    avatar_url: str | None = None,
    avatar_file_id: int | None = None,
) -> str:

    if avatar_url:
        return avatar_url

    base = getattr(
        settings,
        "PUSH_PUBLIC_AVATAR_BASE_URL",
        None,
    )

    if base and avatar_file_id:
        return (
            base.rstrip("/")
            + "/"
            + str(avatar_file_id)
        )

    return ""


def enrich_push_payload(
    *,
    payload: dict[str, Any],
    chat_id: int,
    sender_username: str | None,
    sender_avatar_url: str | None,
    sender_avatar_file_id: int | None,
) -> dict[str, Any]:

    out = dict(payload or {})

    out["chat_id"] = chat_id

    display = make_sender_display(
        sender_username
    )

    out["sender_username"] = sender_username
    out["sender_display"] = display

    icon = make_avatar_icon_url(
        avatar_url=sender_avatar_url,
        avatar_file_id=sender_avatar_file_id,
    )

    if icon:
        out["avatar_icon_url"] = icon

    if "title" not in out:
        out["title"] = display

    return out


# ============================================================
# SCHEMAS
# ============================================================

class SubKeysIn(BaseModel):

    p256dh: str

    auth: str


class SubscribeIn(BaseModel):

    endpoint: str

    keys: SubKeysIn

    user_agent: str | None = None


# ============================================================
# ROUTES
# ============================================================

@router.get("/vapid_public_key")
def vapid_public_key():

    _require_vapid()

    return {
        "publicKey":
        _get_vapid_public_key()
    }


@router.post("/subscribe")
def subscribe(
    data: SubscribeIn,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):

    _require_vapid()

    row = PushSubscription(
        user_id=user.id,
        endpoint=data.endpoint,
        p256dh=data.keys.p256dh,
        auth=data.keys.auth,
        user_agent=data.user_agent,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )

    db.add(row)

    db.commit()

    return {"ok": True}


# ============================================================
# SEND PUSH
# ============================================================

def send_webpush_to_user(
    db: Session,
    user_id: int,
    data: dict[str, Any],
):

    pem = _ensure_vapid_pem_file()

    if not pem:
        return

    subs = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == user_id
        )
        .all()
    )

    payload = json.dumps(
        data,
        ensure_ascii=False,
    ).encode("utf-8")

    for s in subs:

        try:

            webpush(

                subscription_info={
                    "endpoint": s.endpoint,
                    "keys": {
                        "p256dh": s.p256dh,
                        "auth": s.auth,
                    },
                },

                data=payload,

                vapid_private_key=pem,

                vapid_claims={
                    "sub": settings.VAPID_SUBJECT
                },

                ttl=60,

            )

        except WebPushException as e:

            log.warning(
                "push failed %s",
                e,
            )


# ============================================================
# TEST
# ============================================================

@router.post("/test")
def test_push(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):

    payload = enrich_push_payload(

        payload={
            "body": "Test message",
            "ts": datetime.utcnow().isoformat(),
        },

        chat_id=1,

        sender_username=user.username,

        sender_avatar_url=getattr(
            user,
            "avatar_url",
            None,
        ),

        sender_avatar_file_id=getattr(
            user,
            "avatar_file_id",
            None,
        ),

    )

    send_webpush_to_user(
        db,
        user.id,
        payload,
    )

    return {"ok": True}