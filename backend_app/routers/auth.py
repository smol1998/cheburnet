from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user
from backend_app import models
from backend_app.security import hash_password, verify_password, create_token

router = APIRouter()


class AuthIn(BaseModel):
    username: str
    password: str


@router.post("/register")
def register(data: AuthIn, db: Session = Depends(get_db)):
    username = data.username.strip()
    password = data.password.strip()

    if not username or not password:
        raise HTTPException(400, "Username/password required")

    if db.query(models.User).filter_by(username=username).first():
        raise HTTPException(400, "Username already exists")

    u = models.User(username=username, password_hash=hash_password(password))
    db.add(u)
    db.commit()
    db.refresh(u)

    return {"id": u.id, "username": u.username}


@router.post("/login")
def login(data: AuthIn, db: Session = Depends(get_db)):
    username = data.username.strip()
    password = data.password.strip()

    u = db.query(models.User).filter_by(username=username).first()
    if not u or not verify_password(password, u.password_hash):
        raise HTTPException(401, "Invalid credentials")

    return {"access_token": create_token(u.id)}


@router.get("/me")
def me(user=Depends(get_current_user)):
    return {"id": user.id, "username": user.username}
