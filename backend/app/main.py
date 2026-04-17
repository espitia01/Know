import hashlib
import os
import secrets

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.papers import router as papers_router
from .api.analysis import router as analysis_router
from .api.search import router as search_router
from .api.settings import router as settings_router
from .config import settings

app = FastAPI(title="Know", description="Pedagogical Paper Enhancement Platform")

allowed_origins = [
    "http://localhost:3000",
]
extra_origins = os.environ.get("KNOW_CORS_ORIGINS", "")
if extra_origins:
    allowed_origins.extend([o.strip() for o in extra_origins.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple in-memory token store (survives for the lifetime of the server process)
_valid_tokens: set[str] = set()

PUBLIC_PATHS = {"/api/health", "/api/auth/login"}


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    if path in PUBLIC_PATHS or not path.startswith("/api/"):
        return await call_next(request)

    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        if token in _valid_tokens:
            return await call_next(request)

    return JSONResponse(status_code=401, content={"detail": "Unauthorized"})


@app.post("/api/auth/login")
async def login(body: dict):
    password = body.get("password", "")
    if password == settings.password:
        token = secrets.token_hex(32)
        _valid_tokens.add(token)
        return {"token": token}
    return JSONResponse(status_code=401, content={"detail": "Wrong password"})


@app.post("/api/auth/logout")
async def logout(request: Request):
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        _valid_tokens.discard(auth_header[7:])
    return {"status": "ok"}


@app.get("/api/auth/check")
async def check_auth(request: Request):
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer ") and auth_header[7:] in _valid_tokens:
        return {"authenticated": True}
    return JSONResponse(status_code=401, content={"detail": "Unauthorized"})


@app.get("/api/health")
async def health():
    return {"status": "ok"}


app.include_router(papers_router)
app.include_router(analysis_router)
app.include_router(search_router)
app.include_router(settings_router)
