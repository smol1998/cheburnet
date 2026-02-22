from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend_app.db import engine
from backend_app.models import Base
from backend_app.ws import router as ws_router
from backend_app.routers import auth, users, chats, files, assistant  # ✅ добавили assistant

app = FastAPI(title="Telegram MVP")


@app.on_event("startup")
def on_startup():
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

# ✅ GPT assistant endpoint
app.include_router(assistant.router, prefix="/assistant", tags=["assistant"])

app.include_router(ws_router)  # /ws

# --- FRONTEND ---
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
STATIC_DIR = FRONTEND_DIR / "static"

# ВАЖНО: /static должен смотреть именно в папку frontend/static
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
else:
    # fallback: если вдруг у тебя app.js лежит прямо в frontend/
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h3>frontend/index.html not found</h3>", status_code=500)
    return FileResponse(index_path)


@app.get("/ping")
def ping():
    return {"ok": True}