from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.papers import router as papers_router
from .api.analysis import router as analysis_router
from .api.search import router as search_router
from .api.settings import router as settings_router

app = FastAPI(title="Know", description="Pedagogical Paper Enhancement Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
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
