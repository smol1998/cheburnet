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

# -------------------------
# VAPID private key -> PEM file (MOST STABLE)
# -------------------------

_PEM_BEGIN_RE = re.compile(r"-----BEGIN [A-Z0-9 ]+-----")
_PEM_END_RE = re.compile(r"-----END [A-Z0-9 ]+-----")

_VAPID_PEM_CACHE_PATH = "/tmp/vapid_private.pem"
_VAPID_PEM_CACHE_RAW_FINGERPRINT = None  # in-process cache


def _strip_ws(s: str) -> str:
    return "".join((s or "").split())


def _b64_any_to_bytes(s: str) -> bytes:
    """
    Decode base64 OR base64url.
    Accepts missing padding, '-' '_' variants, and whitespace.
    """
    x = _strip_ws(s)
    if not x:
        return b""
    x = x.replace("-", "+").replace("_", "/")
    pad = (-len(x)) % 4
    if pad:
        x += "=" * pad
    return base64.b64decode(x, validate=False)


def _chunk64(s: str) -> str:
    return "\n".join(s[i : i + 64] for i in range(0, len(s), 64) if s[i : i + 64])


def _normalize_pem(pem: str) -> str:
    """
    Normalize any PEM-like input to strict PEM with LF and trailing newline.
    Handles:
    - real newlines
    - '\\n' escaped newlines
    - CRLF
    - PEM in one line (BEGIN...END without newlines)
    """
    x = (pem or "").strip()
    if not x:
        return ""

    x = x.replace("\\r\\n", "\n").replace("\\n", "\n")
    x = x.replace("\r\n", "\n").replace("\r", "\n").strip()

    # already multiline PEM
    if "-----BEGIN" in x and "-----END" in x and "\n" in x:
        lines = [ln.strip() for ln in x.split("\n") if ln.strip()]
        return "\n".join(lines) + "\n"

    # single-line PEM
    if "-----BEGIN" in x and "-----END" in x and "\n" not in x:
        m1 = _PEM_BEGIN_RE.search(x)
        m2 = _PEM_END_RE.search(x)
        if m1 and m2:
            begin = m1.group(0)
            end = m2.group(0)
            inner = x[x.find(begin) + len(begin) : x.find(end)].strip().replace(" ", "")
            return f"{begin}\n{_chunk64(inner)}\n{end}\n"

    return x + ("\n" if not x.endswith("\n") else "")


def _raw_env_private_key() -> str | None:
    """
    settings.VAPID_PRIVATE_KEY_PEM_B64:
      - either base64/base64url(PEM text)
      - or raw PEM text
    """
    v = settings.VAPID_PRIVATE_KEY_PEM_B64
    if not v:
        return None
    return str(v).strip()


def _private_key_to_pem_text(raw: str) -> str:
    """
    100% robust:
    - if raw already PEM -> normalize and return
    - else assume base64/base64url that decodes to PEM text (UTF-8)
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("empty private key")

    if "-----BEGIN" in s and "-----END" in s:
        pem = _normalize_pem(s)
        if "-----BEGIN" not in pem or "-----END" not in pem:
            raise ValueError("PEM markers present but invalid after normalize")
        return pem

    # base64/base64url -> bytes -> text
    try:
        b = _b64_any_to_bytes(s)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"base64 decode failed: {e}") from e

    if not b:
        raise ValueError("base64 decode returned empty")

    try:
        txt = b.decode("utf-8")
    except UnicodeDecodeError as e:
        raise ValueError("base64 does not decode to UTF-8 PEM text") from e

    if "-----BEGIN" not in txt or "-----END" not in txt:
        raise ValueError("decoded text is not PEM")

    return _normalize_pem(txt)


def _ensure_vapid_pem_file() -> str | None:
    """
    Writes normalized PEM into /tmp/vapid_private.pem and returns its path.
    Cached per-process by fingerprint to avoid rewriting every request.
    """
    global _VAPID_PEM_CACHE_RAW_FINGERPRINT

    raw = _raw_env_private_key()
    if not raw:
        return None

    # fingerprint for hot-reload env changes (rare, but ok)
    fp = str(hash(raw))

    if _VAPID_PEM_CACHE_RAW_FINGERPRINT == fp and os.path.exists(_VAPID_PEM_CACHE_PATH):
        return _VAPID_PEM_CACHE_PATH

    try:
        pem_text = _private_key_to_pem_text(raw)
    except Exception as e:
        log.error("VAPID private key invalid: %s", e)
        return None

    try:
        with open(_VAPID_PEM_CACHE_PATH, "w", encoding="utf-8", newline="\n") as f:
            f.write(pem_text)
        _VAPID_PEM_CACHE_RAW_FINGERPRINT = fp
        return _VAPID_PEM_CACHE_PATH
    except Exception as e:
        log.error("Cannot write VAPID pem file: %s", e)
        return None


def _get_vapid_public_key() -> str | None:
    pub = settings.VAPID_PUBLIC_KEY_B64URL
    return str(pub).strip() if pub else None


def _require_vapid():
    if not _ensure_vapid_pem_file() or not _get_vapid_public_key():
        raise HTTPException(500, "VAPID keys are not configured on server")


def _to_base64url(s: str) -> str:
    """
    Subscription keys must be base64url without '='.
    Normalize just in case.
    """
    x = (s or "").strip()
    if not x:
        return ""
    x = _strip_ws(x)
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
    Sync webpush to all subscriptions.
    Returns details for debugging.
    """
    pem_path = _ensure_vapid_pem_file()
    if not pem_path:
        return {"sent": 0, "total": 0, "reason": "bad_or_missing_private_key"}

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
                vapid_private_key=pem_path,  # ✅ path to PEM file (most compatible) :contentReference[oaicite:3]{index=3}
                vapid_claims={"sub": settings.VAPID_SUBJECT},
                ttl=60,
                content_encoding="aes128gcm",
            )
            ok += 1

        except WebPushException as e:
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            body = getattr(getattr(e, "response", None), "text", None)
            err = {
                "endpoint": s.endpoint[:140],
                "status_code": status_code,
                "error": str(e),
                "response_text": body[:400] if isinstance(body, str) else None,
            }
            errors.append(err)
            log.warning("WebPushException: %s", err)

            if status_code in (404, 410):
                to_delete.append(s.id)

        except Exception as e:
            err = {"endpoint": s.endpoint[:140], "error": repr(e)}
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