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

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

from backend_app.deps import get_db, get_current_user
from backend_app.models import PushSubscription
from backend_app.config import settings

router = APIRouter()
log = logging.getLogger("push")


# -------------------------
# Helpers: base64/base64url
# -------------------------

def _strip_ws(s: str) -> str:
    return "".join((s or "").split())


def _b64_any_to_bytes(s: str) -> bytes:
    """
    Decodes base64 OR base64url (tolerant to missing padding).
    """
    x = _strip_ws(s)
    if not x:
        return b""

    # base64url -> base64
    x = x.replace("-", "+").replace("_", "/")

    # padding
    pad = (-len(x)) % 4
    if pad:
        x += "=" * pad

    return base64.b64decode(x, validate=False)


def _b64url_no_pad(b: bytes) -> str:
    """
    bytes -> base64url without '='
    """
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


# -------------------------
# Helpers: PEM normalization
# -------------------------

_PEM_BEGIN_RE = re.compile(r"-----BEGIN [A-Z0-9 ]+-----")
_PEM_END_RE = re.compile(r"-----END [A-Z0-9 ]+-----")


def _chunk64(s: str) -> str:
    return "\n".join(s[i : i + 64] for i in range(0, len(s), 64) if s[i : i + 64])


def _normalize_pem_multiline(pem: str) -> str:
    """
    Normalize ANY "PEM-like" string into valid PEM with LF newlines and trailing '\n'.
    Handles:
      - real \n, CRLF
      - literal '\\n'
      - PEM in one line
      - extra spaces/empty lines
    """
    x = (pem or "").strip()
    if not x:
        return x

    # 1) unescape
    x = x.replace("\\r\\n", "\n").replace("\\n", "\n")
    # 2) CRLF -> LF
    x = x.replace("\r\n", "\n").replace("\r", "\n").strip()

    # already multiline PEM
    if "-----BEGIN" in x and "-----END" in x and "\n" in x:
        lines = [ln.strip() for ln in x.split("\n") if ln.strip()]
        return "\n".join(lines) + "\n"

    # one-line PEM
    if "-----BEGIN" in x and "-----END" in x and "\n" not in x:
        m1 = _PEM_BEGIN_RE.search(x)
        m2 = _PEM_END_RE.search(x)
        if m1 and m2:
            begin = m1.group(0)
            end = m2.group(0)
            inner = x[x.find(begin) + len(begin) : x.find(end)].strip()
            inner = inner.replace(" ", "")
            body = _chunk64(inner)
            return f"{begin}\n{body}\n{end}\n"

    return x


# -------------------------
# ✅ VAPID private key: normalize to base64url(DER)
# -------------------------

def _pem_to_der_pkcs8(pem_text: str) -> bytes:
    """
    Loads PEM private key and exports it as PKCS8 DER bytes.
    """
    key = serialization.load_pem_private_key(
        pem_text.encode("utf-8"),
        password=None,
        backend=default_backend(),
    )
    der = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return der


def _der_validate_and_normalize_to_pkcs8(der: bytes) -> bytes:
    """
    Validate DER is a private key and re-export as PKCS8 DER (stable).
    """
    key = serialization.load_der_private_key(der, password=None, backend=default_backend())
    der2 = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return der2


def _normalize_vapid_private_key_to_b64url_der(raw: str) -> str:
    """
    100% robust normalization:
    Accepts raw in any of these formats:
      - PEM (multiline / one-line / with \\n / CRLF)
      - base64(PEM)
      - base64url(PEM)
      - base64/base64url(DER)
    Returns: base64url(PKCS8-DER) WITHOUT '='

    This matches what your py_vapid version expects (it b64urldecode()'s the string).
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("empty VAPID private key")

    # (A) Looks like PEM
    if "-----BEGIN" in s and "-----END" in s:
        pem = _normalize_pem_multiline(s)
        der = _pem_to_der_pkcs8(pem)
        return _b64url_no_pad(der)

    # (B) Otherwise decode base64/base64url to bytes
    b = _b64_any_to_bytes(s)
    if not b:
        raise ValueError("base64 decode returned empty bytes")

    # (B1) Maybe those bytes are UTF-8 PEM text (base64(PEM))
    try:
        txt = b.decode("utf-8")
        if "-----BEGIN" in txt and "-----END" in txt:
            pem = _normalize_pem_multiline(txt)
            der = _pem_to_der_pkcs8(pem)
            return _b64url_no_pad(der)
    except UnicodeDecodeError:
        pass

    # (B2) Otherwise treat as DER private key
    der2 = _der_validate_and_normalize_to_pkcs8(b)
    return _b64url_no_pad(der2)


def _get_vapid_private_key_for_pywebpush() -> str | None:
    """
    Returns base64url(DER) string expected by py_vapid (NO '=').
    """
    raw = settings.VAPID_PRIVATE_KEY_PEM_B64
    if not raw:
        return None
    try:
        return _normalize_vapid_private_key_to_b64url_der(str(raw))
    except Exception as e:
        log.error("VAPID private key normalization failed: %s", e)
        return None


def _get_vapid_public_key() -> str | None:
    pub = settings.VAPID_PUBLIC_KEY_B64URL
    if not pub:
        return None
    return str(pub).strip()


def _require_vapid():
    # Private key must be convertible, public key must exist
    if not _get_vapid_private_key_for_pywebpush() or not _get_vapid_public_key():
        raise HTTPException(500, "VAPID keys are not configured on server")


def _to_base64url(s: str) -> str:
    """
    Subscription keys MUST be base64url without '='.
    (Some browsers/old code can give base64 with +/ and padding.)
    """
    x = (s or "").strip()
    if not x:
        return x
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
    Sync send webpush to all user subscriptions.
    Returns details to debug sent=0.
    """
    priv = _get_vapid_private_key_for_pywebpush()
    if not priv:
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
                vapid_private_key=priv,  # ✅ base64url(DER) string (what py_vapid expects)
                vapid_claims={"sub": settings.VAPID_SUBJECT},
                ttl=60,
            )
            ok += 1

        except WebPushException as e:
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            body = getattr(getattr(e, "response", None), "text", None)

            err = {
                "endpoint": s.endpoint[:140],
                "status_code": status_code,
                "error": str(e),
                "response_text": body[:300] if isinstance(body, str) else None,
            }
            errors.append(err)
            log.warning("WebPushException: %s", err)

            # dead subscriptions
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