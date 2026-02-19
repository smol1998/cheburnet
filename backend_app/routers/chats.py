from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import or_, func

from backend_app.deps import get_db, get_current_user
from backend_app import models
from backend_app.ws import manager

router = APIRouter()


def user_public(u: models.User) -> dict:
    avatar_file_id = getattr(u, "avatar_file_id", None)
    return {
        "id": u.id,
        "username": u.username,
        "avatar_file_id": avatar_file_id,
        "avatar_url": (f"/files/{avatar_file_id}" if avatar_file_id else None),
    }


class StartDMIn(BaseModel):
    other_user_id: int


class SendMessageIn(BaseModel):
    text: str | None = None
    file_ids: list[int] = []


class ReadIn(BaseModel):
    last_read_message_id: int


def normalize_pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def ensure_chat_member(db: Session, chat_id: int, user_id: int) -> models.DMChat:
    chat = db.get(models.DMChat, chat_id)
    if not chat or user_id not in (chat.user1_id, chat.user2_id):
        raise HTTPException(404, "Chat not found")
    return chat


def other_id(chat: models.DMChat, me: int) -> int:
    return chat.user2_id if chat.user1_id == me else chat.user1_id


def msg_to_dict(db: Session, m: models.Message):
    attaches = (
        db.query(models.File)
        .join(models.MessageAttachment, models.File.id == models.MessageAttachment.file_id)
        .filter(models.MessageAttachment.message_id == m.id)
        .all()
    )
    return {
        "id": m.id,
        "sender_id": m.sender_id,
        "text": m.text,
        "created_at": m.created_at.isoformat(),
        "attachments": [
            {"id": f.id, "mime": f.mime, "name": f.original_name, "url": f"/files/{f.id}"}
            for f in attaches
        ],
    }


def get_read_state(db: Session, chat_id: int, user_id: int) -> int:
    r = db.query(models.DMRead).filter_by(chat_id=chat_id, user_id=user_id).first()
    return r.last_read_message_id if r else 0


@router.post("/dm/start")
def start_dm(data: StartDMIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    if data.other_user_id == user.id:
        raise HTTPException(400, "Cannot chat with yourself")

    other = db.get(models.User, data.other_user_id)
    if not other:
        raise HTTPException(404, "User not found")

    u1, u2 = normalize_pair(user.id, other.id)
    chat = db.query(models.DMChat).filter_by(user1_id=u1, user2_id=u2).first()
    if not chat:
        chat = models.DMChat(user1_id=u1, user2_id=u2)
        db.add(chat)
        db.commit()
        db.refresh(chat)

        db.add(models.DMRead(chat_id=chat.id, user_id=user.id, last_read_message_id=0))
        db.add(models.DMRead(chat_id=chat.id, user_id=other.id, last_read_message_id=0))
        db.commit()

    return {"chat_id": chat.id, "with": user_public(other)}


@router.get("/dm/list")
def list_dm(db: Session = Depends(get_db), user=Depends(get_current_user)):
    chats = (
        db.query(models.DMChat)
        .filter(or_(models.DMChat.user1_id == user.id, models.DMChat.user2_id == user.id))
        .order_by(models.DMChat.id.desc())
        .limit(50)
        .all()
    )

    out = []
    for c in chats:
        oid = other_id(c, user.id)
        other = db.get(models.User, oid)

        # ✅ последнее ВХОДЯЩЕЕ (не от меня) сообщение — только оно влияет на NEW
        last_incoming_id = (
                               db.query(func.max(models.Message.id))
                               .filter(models.Message.chat_id == c.id)
                               .filter(models.Message.sender_id != user.id)
                               .scalar()
                           ) or 0

        out.append(
            {
                "chat_id": c.id,
                "other": user_public(other),
                "other_online": manager.is_online(oid),
                "my_last_read": get_read_state(db, c.id, user.id),
                "other_last_read": get_read_state(db, c.id, oid),
                "last_incoming_id": int(last_incoming_id),
            }
        )
    return out


@router.get("/dm/{chat_id}/messages")
def history(
    chat_id: int,
    before_id: int | None = None,
    limit: int = 50,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    chat = ensure_chat_member(db, chat_id, user.id)

    q = db.query(models.Message).filter(models.Message.chat_id == chat_id)
    if before_id is not None:
        q = q.filter(models.Message.id < before_id)

    rows = q.order_by(models.Message.id.desc()).limit(min(max(limit, 1), 200)).all()
    rows.reverse()

    oid = other_id(chat, user.id)
    return {
        "items": [msg_to_dict(db, m) for m in rows],
        "next_before_id": rows[0].id if rows else None,
        "read_state": {
            "my_last_read": get_read_state(db, chat_id, user.id),
            "other_last_read": get_read_state(db, chat_id, oid),
        },
    }


@router.post("/dm/{chat_id}/send")
async def send(chat_id: int, data: SendMessageIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    chat = ensure_chat_member(db, chat_id, user.id)

    if (not data.text or not data.text.strip()) and not data.file_ids:
        raise HTTPException(400, "Empty message")

    msg = models.Message(chat_id=chat_id, sender_id=user.id, text=(data.text.strip() if data.text else None))
    db.add(msg)
    db.commit()
    db.refresh(msg)

    for fid in data.file_ids:
        f = db.get(models.File, fid)
        if f:
            db.add(models.MessageAttachment(message_id=msg.id, file_id=fid))
    db.commit()

    message_dict = msg_to_dict(db, msg)
    oid = other_id(chat, user.id)

    payload = {"type": "message:new", "chat_id": chat_id, "message": message_dict}
    await manager.send(oid, payload)

    return message_dict


@router.post("/dm/{chat_id}/read")
async def mark_read(chat_id: int, data: ReadIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    chat = ensure_chat_member(db, chat_id, user.id)

    m = db.get(models.Message, data.last_read_message_id)
    if not m or m.chat_id != chat_id:
        raise HTTPException(400, "Invalid message id")

    row = db.query(models.DMRead).filter_by(chat_id=chat_id, user_id=user.id).first()
    if not row:
        row = models.DMRead(chat_id=chat_id, user_id=user.id, last_read_message_id=0)
        db.add(row)

    if data.last_read_message_id > row.last_read_message_id:
        row.last_read_message_id = data.last_read_message_id
        row.updated_at = datetime.utcnow()
        db.commit()

        oid = other_id(chat, user.id)
        await manager.send(
            oid,
            {
                "type": "message:read",
                "chat_id": chat_id,
                "user_id": user.id,
                "last_read_message_id": row.last_read_message_id,
            },
        )

    return {"ok": True, "last_read_message_id": row.last_read_message_id}
