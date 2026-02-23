from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend_app.db import engine
from backend_app.models import Base
from backend_app.ws import router as ws_router
from backend_app.routers import auth, users, chats, files, assistant, push  # ✅ push добавили

app = FastAPI(title="Telegram MVP")


@app.on_event("startup")
def on_startup():
    # ⚠️ create_all создаст НОВУЮ таблицу push_subscriptions,
    # но не умеет менять существующие таблицы (для этого alembic).
    Base.metadata.create_all(bind=engine)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(users.router, prefix="/users", tags=["users"])
app.include_router(chats.router, prefix="/chats", tags=["chats"])
app.include_router(files.router, prefix="/files", tags=["files"])
app.include_router(assistant.router, prefix="/assistant", tags=["assistant"])

# ✅ Web Push endpoints
app.include_router(push.router, prefix="/push", tags=["push"])

app.include_router(ws_router)  # /ws

# --- FRONTEND ---
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
STATIC_DIR = FRONTEND_DIR / "static"

# ВАЖНО: /static должен смотреть именно в папку frontend/static
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
else:
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


# ✅ Service Worker из корня, чтобы scope был "/" и пуш работал на весь сайт
@app.get("/sw.js")
def service_worker():
    sw_path = STATIC_DIR / "sw.js"
    if not sw_path.exists():
        return HTMLResponse("sw.js not found", status_code=404)
    return FileResponse(sw_path, media_type="application/javascript")


@app.get("/", response_class=HTMLResponse)
def index():
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h3>frontend/index.html not found</h3>", status_code=500)
    return FileResponse(index_path)


@app.get("/ping")
def ping():
    return {"ok": True}