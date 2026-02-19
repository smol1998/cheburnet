from fastapi import APIRouter, Depends
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
