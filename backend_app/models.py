from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, DateTime, ForeignKey, Text, UniqueConstraint,
    LargeBinary,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)

    birth_year = Column(Integer, nullable=True)

    # аватар — ссылка на files.id
    avatar_file_id = Column(Integer, ForeignKey("files.id"), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # ✅ Явно указываем какой FK используется (иначе ambiguous)
    avatar = relationship("File", foreign_keys=[avatar_file_id], uselist=False)


class DMChat(Base):
    __tablename__ = "dm_chats"
    __table_args__ = (UniqueConstraint("user1_id", "user2_id", name="uq_dm_pair"),)

    id = Column(Integer, primary_key=True)
    user1_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    user2_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    user1 = relationship("User", foreign_keys=[user1_id])
    user2 = relationship("User", foreign_keys=[user2_id])


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True)
    chat_id = Column(Integer, ForeignKey("dm_chats.id"), nullable=False, index=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    text = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    chat = relationship("DMChat")
    sender = relationship("User", foreign_keys=[sender_id])


class File(Base):
    __tablename__ = "files"

    id = Column(Integer, primary_key=True)

    # владелец файла — ссылка на users.id
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    original_name = Column(String(255), nullable=False)
    mime = Column(String(128), nullable=False)
    size = Column(Integer, nullable=False)

    # ✅ данные файла в БД (Postgres bytea / SQLite blob)
    data = Column(LargeBinary, nullable=False)

    # оставляем поле path для совместимости/будущего, но оно больше не используется
    path = Column(String(512), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # ✅ ВАЖНО: явно указываем FK owner_id, иначе ambiguous
    owner = relationship("User", foreign_keys=[owner_id])


class MessageAttachment(Base):
    __tablename__ = "message_attachments"
    __table_args__ = (UniqueConstraint("message_id", "file_id", name="uq_msg_file"),)

    id = Column(Integer, primary_key=True)
    message_id = Column(Integer, ForeignKey("messages.id"), nullable=False, index=True)
    file_id = Column(Integer, ForeignKey("files.id"), nullable=False, index=True)


class DMRead(Base):
    __tablename__ = "dm_reads"
    __table_args__ = (UniqueConstraint("chat_id", "user_id", name="uq_read_state"),)

    id = Column(Integer, primary_key=True)
    chat_id = Column(Integer, ForeignKey("dm_chats.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    last_read_message_id = Column(Integer, default=0, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    chat = relationship("DMChat")
    user = relationship("User", foreign_keys=[user_id])
