# ws.py
import json
from typing import Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from sqlalchemy.orm import Session

from backend_app.security import decode_token
from backend_app.db import SessionLocal
from backend_app import models

router = APIRouter()


def _payload_to_user_id(payload: Any) -> Optional[int]:
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


def get_other_user_id(db: Session, chat_id: int, me_id: int) -> int | None:
    chat = db.get(models.DMChat, chat_id)
    if not chat:
        return None
    if me_id not in (chat.user1_id, chat.user2_id):
        return None
    return chat.user2_id if chat.user1_id == me_id else chat.user1_id


class WSManager:
    def __init__(self):
        self.by_user: dict[int, set[WebSocket]] = {}
        self.subscriptions: dict[int, set[int]] = {}

    def is_online(self, user_id: int) -> bool:
        return user_id in self.by_user and len(self.by_user[user_id]) > 0

    async def connect(self, user_id: int, ws: WebSocket):
        await ws.accept()
        self.by_user.setdefault(user_id, set()).add(ws)
        self.subscriptions.setdefault(user_id, set())

    def disconnect(self, user_id: int, ws: WebSocket):
        self.by_user.get(user_id, set()).discard(ws)
        if user_id in self.by_user and not self.by_user[user_id]:
            del self.by_user[user_id]
        if user_id in self.subscriptions:
            self.subscriptions[user_id].clear()

    async def send(self, user_id: int, payload: dict):
        for ws in list(self.by_user.get(user_id, set())):
            try:
                await ws.send_json(payload)
            except Exception:
                # если сокет умер — не валим всех
                pass

    def subscribe(self, user_id: int, chat_id: int):
        self.subscriptions.setdefault(user_id, set()).add(chat_id)

    def unsubscribe(self, user_id: int, chat_id: int):
        self.subscriptions.get(user_id, set()).discard(chat_id)

    def is_subscribed(self, user_id: int, chat_id: int) -> bool:
        return chat_id in self.subscriptions.get(user_id, set())


manager = WSManager()


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = Query(...)):
    try:
        payload = decode_token(token)
        user_id = _payload_to_user_id(payload)
        if not user_id:
            raise Exception("bad token payload")
    except Exception:
        await ws.close(code=1008)
        return

    await manager.connect(user_id, ws)
    db = SessionLocal()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                continue

            t = data.get("type")
            chat_id = data.get("chat_id")

            if t == "presence:subscribe" and isinstance(chat_id, int):
                other_id = get_other_user_id(db, chat_id, user_id)
                if other_id is None:
                    continue

                manager.subscribe(user_id, chat_id)

                await manager.send(user_id, {
                    "type": "presence:state",
                    "chat_id": chat_id,
                    "user_id": other_id,
                    "online": manager.is_online(other_id),
                })

                if manager.is_subscribed(other_id, chat_id):
                    await manager.send(other_id, {
                        "type": "presence:state",
                        "chat_id": chat_id,
                        "user_id": user_id,
                        "online": True,
                    })

            elif t == "presence:unsubscribe" and isinstance(chat_id, int):
                manager.unsubscribe(user_id, chat_id)

            elif t in ("typing:start", "typing:stop") and isinstance(chat_id, int):
                other_id = get_other_user_id(db, chat_id, user_id)
                if other_id is None:
                    continue
                if manager.is_subscribed(other_id, chat_id):
                    await manager.send(other_id, {
                        "type": t,
                        "chat_id": chat_id,
                        "from_user_id": user_id,
                    })

            elif t == "ping":
                await ws.send_json({"type": "pong"})

    except WebSocketDisconnect:
        try:
            subs = list(manager.subscriptions.get(user_id, set()))
            for chat_id in subs:
                other_id = get_other_user_id(db, chat_id, user_id)
                if other_id is not None and manager.is_subscribed(other_id, chat_id):
                    await manager.send(other_id, {
                        "type": "presence:state",
                        "chat_id": chat_id,
                        "user_id": user_id,
                        "online": False,
                    })
        finally:
            manager.disconnect(user_id, ws)
    finally:
        db.close()
