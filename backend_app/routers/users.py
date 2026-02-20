from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend_app.deps import get_db, get_current_user
from backend_app import models

router = APIRouter()


@router.get("/search")
def search_users(q: str, db: Session = Depends(get_db), user=Depends(get_current_user)):
    query = (q or "").strip()
    if not query:
        return []

    rows = (
        db.query(models.User)
        .filter(models.User.username.contains(query))
        .order_by(models.User.username.asc())
        .limit(20)
        .all()
    )

    out = []
    for r in rows:
        if r.id == user.id:
            continue

        avatar_file_id = getattr(r, "avatar_file_id", None)
        out.append(
            {
                "id": r.id,
                "username": r.username,
                "avatar_file_id": avatar_file_id,
                "avatar_url": (f"/files/{avatar_file_id}" if avatar_file_id else None),
            }
        )
    return out


class UpdateMeIn(BaseModel):
    birth_year: int | None = None
    avatar_file_id: int | None = None


@router.patch("/me")
def update_me(data: UpdateMeIn, db: Session = Depends(get_db), user=Depends(get_current_user)):
    # birth_year
    if data.birth_year is not None:
        if data.birth_year < 1900 or data.birth_year > 2100:
            raise HTTPException(400, "Invalid birth_year")
        user.birth_year = data.birth_year
    else:
        # если явно прислали null — очищаем
        user.birth_year = None

    # avatar_file_id
    if data.avatar_file_id is not None:
        f = db.get(models.File, int(data.avatar_file_id))
        if not f:
            raise HTTPException(404, "Avatar file not found")
        if f.owner_id != user.id:
            raise HTTPException(403, "You can set only your own file as avatar")
        if not (f.mime or "").startswith("image/"):
            raise HTTPException(400, "Avatar must be image/*")

        user.avatar_file_id = f.id
    # если avatar_file_id == null → НЕ меняем аватар (так удобнее фронту)
    # если хочешь уметь удалять аватарку — добавим отдельный флаг/эндпоинт.

    db.add(user)
    db.commit()
    db.refresh(user)

    avatar_file_id = getattr(user, "avatar_file_id", None)
    return {
        "id": user.id,
        "username": user.username,
        "birth_year": user.birth_year,
        "avatar_file_id": avatar_file_id,
        "avatar_url": (f"/files/{avatar_file_id}" if avatar_file_id else None),
    }