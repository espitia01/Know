import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.papers import router as papers_router
from .api.analysis import router as analysis_router
from .api.search import router as search_router
from .api.settings import router as settings_router

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

app.include_router(papers_router)
app.include_router(analysis_router)
app.include_router(search_router)
app.include_router(settings_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
