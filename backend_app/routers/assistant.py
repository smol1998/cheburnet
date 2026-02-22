from __future__ import annotations

import json
import time
from collections import deque
from typing import Deque, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend_app import models
from backend_app.config import settings
from backend_app.deps import get_current_user, get_db

router = APIRouter()

# -------------------------
# In-memory rate limiters
# -------------------------
_user_last_ts_ms: Dict[int, int] = {}
_user_minute_ts: Dict[int, Deque[int]] = {}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clip(s: str, n: int) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    if n <= 0:
        return ""
    return s if len(s) <= n else s[:n]


def _rate_limit(user_id: int) -> None:
    now = _now_ms()

    # min interval
    min_interval = int(getattr(settings, "assistant_min_interval_ms", 1200))
    last = _user_last_ts_ms.get(user_id, 0)
    if now - last < min_interval:
        raise HTTPException(status_code=429, detail="Assistant rate limit: too frequent")

    # per-minute
    rpm = int(getattr(settings, "assistant_max_requests_per_minute", 20))
    dq = _user_minute_ts.get(user_id)
    if dq is None:
        dq = deque()
        _user_minute_ts[user_id] = dq

    one_min_ago = now - 60_000
    while dq and dq[0] < one_min_ago:
        dq.popleft()

    if len(dq) >= rpm:
        raise HTTPException(status_code=429, detail="Assistant rate limit: too many requests")

    dq.append(now)
    _user_last_ts_ms[user_id] = now


def _ensure_chat_member(db: Session, chat_id: int, user_id: int) -> models.DMChat:
    chat = db.get(models.DMChat, chat_id)
    if not chat or user_id not in (chat.user1_id, chat.user2_id):
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


def _other_id(chat: models.DMChat, me_id: int) -> int:
    return chat.user2_id if chat.user1_id == me_id else chat.user1_id


# -------------------------
# Schemas
# -------------------------
class AssistantMsg(BaseModel):
    sender: str = Field(..., description="me|other")
    text: str


class SuggestIn(BaseModel):
    chat_id: int
    draft: Optional[str] = None
    reason: Optional[str] = "idle"
    messages: List[AssistantMsg] = Field(default_factory=list)

    # backward compatibility (если фронт шлёт text)
    text: Optional[str] = None


class SuggestOut(BaseModel):
    suggestion: str


# -------------------------
# OpenAI helper
# -------------------------
def _build_openai_input(
    system_prompt: str,
    my_username: str,
    other_username: str,
    context_messages: List[AssistantMsg],
    draft: str,
) -> List[dict]:
    sys = (system_prompt or "").strip()
    sys += (
        "\n\n"
        f"Контекст: это чат между мной (@{my_username}) и собеседником (@{other_username}).\n"
        "Твоя задача: предложить краткий черновик сообщения, который можно отправить сейчас.\n"
        "Не добавляй лишних объяснений — только сам текст предложения.\n"
        "1 вариант, 1–3 предложения."
    ).strip()

    input_msgs: List[dict] = [{"role": "system", "content": sys}]

    if context_messages:
        lines: List[str] = []
        for m in context_messages:
            who = "Я" if (m.sender or "").lower() == "me" else "Собеседник"
            t = (m.text or "").strip()
            if t:
                lines.append(f"{who}: {t}")
        if lines:
            input_msgs.append({"role": "user", "content": "История:\n" + "\n".join(lines)})

    input_msgs.append({"role": "user", "content": "Мой черновик:\n" + draft})
    return input_msgs


def _extract_openai_error_text(resp: httpx.Response) -> str:
    try:
        j = resp.json()
        if isinstance(j, dict):
            err = j.get("error")
            if isinstance(err, dict):
                msg = err.get("message")
                typ = err.get("type")
                code = err.get("code")
                bits = [b for b in [msg, typ, code] if b]
                if bits:
                    return " | ".join(str(x) for x in bits)
        return json.dumps(j)[:500]
    except Exception:
        return (resp.text or "")[:500]


async def _call_openai(input_msgs: List[dict]) -> str:
    api_key = (getattr(settings, "openai_api_key", "") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")

    model = (getattr(settings, "openai_model", "") or "gpt-4o-mini").strip()
    max_out = int(getattr(settings, "assistant_max_output_tokens", 120))

    payload = {
        "model": model,
        "input": input_msgs,
        "max_output_tokens": max_out,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    timeout = httpx.Timeout(25.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post("https://api.openai.com/v1/responses", json=payload, headers=headers)

    if r.status_code >= 400:
        reason = _extract_openai_error_text(r)
        # важно: печатаем в консоль, чтобы ты видел прямо в uvicorn
        print(f"[assistant] OpenAI error {r.status_code}: {reason}")
        raise HTTPException(status_code=502, detail=f"OpenAI error {r.status_code}: {reason}")

    data = r.json()

    out_text = (data.get("output_text") or "").strip()
    if out_text:
        return out_text

    # fallback extraction
    try:
        output = data.get("output") or []
        chunks: List[str] = []
        for item in output:
            content = item.get("content") or []
            for c in content:
                if c.get("type") == "output_text" and c.get("text"):
                    chunks.append(c["text"])
        return "\n".join(chunks).strip()
    except Exception:
        return ""


# -------------------------
# Debug endpoint
# -------------------------
@router.get("/debug")
def debug(user=Depends(get_current_user)):
    key = (getattr(settings, "openai_api_key", "") or "").strip()
    return {
        "has_key": bool(key),
        "key_prefix": (key[:10] + "…" + key[-4:]) if key else "",
        "model": (getattr(settings, "openai_model", "") or ""),
        "min_interval_ms": int(getattr(settings, "assistant_min_interval_ms", 1200)),
        "max_requests_per_minute": int(getattr(settings, "assistant_max_requests_per_minute", 20)),
        "max_output_tokens": int(getattr(settings, "assistant_max_output_tokens", 120)),
    }


# -------------------------
# Main endpoint
# -------------------------
@router.post("/suggest", response_model=SuggestOut)
async def suggest(
    data: SuggestIn,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    _rate_limit(int(user.id))

    chat = _ensure_chat_member(db, int(data.chat_id), int(user.id))
    other_user_id = _other_id(chat, int(user.id))
    other = db.get(models.User, other_user_id)
    other_username = other.username if other else "user"

    draft_raw = data.draft if data.draft is not None else data.text
    max_draft = int(getattr(settings, "assistant_max_draft_chars", 800))
    draft = _clip(draft_raw or "", max_draft)
    if not draft:
        raise HTTPException(status_code=400, detail="Empty draft")

    max_n = int(getattr(settings, "assistant_max_messages", 12))
    max_chars = int(getattr(settings, "assistant_max_message_chars", 600))

    msgs: List[AssistantMsg] = []
    for m in (data.messages or [])[: max(0, max_n)]:
        sender = (m.sender or "").strip().lower()
        if sender not in ("me", "other"):
            sender = "other"
        txt = _clip(m.text or "", max_chars)
        if txt:
            msgs.append(AssistantMsg(sender=sender, text=txt))

    input_msgs = _build_openai_input(
        system_prompt=getattr(settings, "assistant_system_prompt", ""),
        my_username=(user.username or "me"),
        other_username=other_username,
        context_messages=msgs,
        draft=draft,
    )

    suggestion = await _call_openai(input_msgs)
    suggestion = _clip(suggestion.strip(), max_draft)

    if not suggestion:
        raise HTTPException(status_code=502, detail="Empty assistant response")

    return SuggestOut(suggestion=suggestion)