import os
import time
import asyncio
import collections

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import settings
from .auth import require_auth


import logging as _logging

_main_logger = _logging.getLogger("know.main")


async def _trial_cleanup_loop():
    """Periodically clean up trial papers older than 2 hours."""
    while True:
        await asyncio.sleep(1800)  # every 30 minutes
        try:
            from .services.db import get_db
            client = get_db()
            if client:
                res = client.rpc("cleanup_trial_data", {"max_age_hours": 2}).execute()
                _main_logger.info("Trial cleanup: removed %s old entries", res.data if res else 0)

            # Also clean disk: trial PDFs and directories older than 2h
            import pathlib
            cutoff = time.time() - 7200
            for p in settings.papers_dir.iterdir():
                if p.name.startswith("trial_"):
                    try:
                        if p.stat().st_mtime < cutoff:
                            if p.is_dir():
                                import shutil
                                shutil.rmtree(p)
                            else:
                                p.unlink()
                    except Exception:
                        pass
        except Exception as e:
            _main_logger.warning("Trial cleanup failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_trial_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="Know", description="Pedagogical Paper Enhancement Platform", lifespan=lifespan)

allowed_origins = [
    "http://localhost:3000",
]
extra_origins = os.environ.get("KNOW_CORS_ORIGINS", "")
if extra_origins:
    for o in extra_origins.split(","):
        origin = o.strip().rstrip("/")
        if origin and origin != "*":
            allowed_origins.append(origin)
        elif origin == "*":
            _main_logger.warning("CORS wildcard '*' rejected. Set explicit domains in KNOW_CORS_ORIGINS.")

_main_logger.info("CORS allowed origins: %s", allowed_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/user/me")
async def get_current_user(user_id: str = Depends(require_auth)):
    """Return current user info including tier. Syncs with Stripe if needed."""
    from .services.db import get_or_create_user, update_user_tier
    user = get_or_create_user(user_id)

    customer_id = user.get("stripe_customer_id")
    tier = user.get("tier", "free")
    cancel_at_period_end = False
    cancel_at = None

    if customer_id and tier == "free":
        try:
            from .api.billing import PRICE_TO_TIER
            import stripe as _stripe
            subs = _stripe.Subscription.list(customer=customer_id, status="active", limit=1)
            if subs.data:
                sub = subs.data[0]
                price_id = sub["items"]["data"][0]["price"]["id"]
                resolved = PRICE_TO_TIER.get(price_id)
                if resolved and resolved != "free":
                    update_user_tier(user_id, resolved)
                    tier = resolved
                cancel_at_period_end = bool(sub.cancel_at_period_end)
                if cancel_at_period_end:
                    try:
                        cancel_at = sub.current_period_end
                    except Exception:
                        pass
        except Exception:
            pass
    elif customer_id and tier != "free":
        try:
            import stripe as _stripe
            subs = _stripe.Subscription.list(customer=customer_id, status="active", limit=1)
            if subs.data:
                sub = subs.data[0]
                cancel_at_period_end = bool(sub.cancel_at_period_end)
                if cancel_at_period_end:
                    try:
                        cancel_at = sub.current_period_end
                    except Exception:
                        pass
        except Exception:
            pass

    return {
        "user_id": user.get("user_id", user_id),
        "tier": tier,
        "paper_count": user.get("paper_count", 0),
        "has_billing": bool(customer_id and tier != "free"),
        "cancel_at_period_end": cancel_at_period_end,
        "cancel_at": cancel_at,
    }


@app.get("/api/usage/{paper_id}")
async def get_paper_usage(paper_id: str, user_id: str = Depends(require_auth)):
    """Return per-paper usage counts and limits for the current user."""
    from .services.db import get_usage_count
    from .gating import get_user_tier, TIER_LIMITS

    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])

    qa_used = get_usage_count(user_id, paper_id, "qa")
    sel_used = get_usage_count(user_id, paper_id, "selection")

    return {
        "qa_used": qa_used,
        "qa_limit": limits.get("qa_per_paper", -1),
        "selections_used": sel_used,
        "selections_limit": limits.get("selections_per_paper", -1),
        "tier": tier,
    }


# --- Trial endpoints (no auth, rate-limited by IP via Supabase) ---

TRIAL_RATE_LIMIT = 5
TRIAL_WINDOW = 3600


def _check_trial_rate(request: Request):
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    from .services.db import get_db
    client = get_db()
    if client:
        try:
            res = client.rpc("check_trial_rate", {
                "p_ip": ip,
                "p_max_requests": TRIAL_RATE_LIMIT,
                "p_window_seconds": TRIAL_WINDOW,
            }).execute()
            if res and res.data is False:
                raise HTTPException(status_code=429, detail="Trial rate limit exceeded. Sign up to continue.")
            return
        except HTTPException:
            raise
        except Exception:
            pass

    # Fallback: in-memory (only used when Supabase is not configured)
    now = time.time()
    if ip not in _trial_fallback:
        _trial_fallback[ip] = collections.deque()
    dq = _trial_fallback[ip]
    while dq and dq[0] < now - TRIAL_WINDOW:
        dq.popleft()
    if len(dq) >= TRIAL_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Trial rate limit exceeded. Sign up to continue.")
    dq.append(now)


_trial_fallback: dict[str, collections.deque] = {}


@app.post("/api/trial/upload")
async def trial_upload(request: Request):
    _check_trial_rate(request)

    from .services.pdf_parser import extract_pdf, save_paper
    from .services.llm import extract_metadata
    import uuid

    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type:
        raise HTTPException(status_code=400, detail="Expected multipart/form-data")

    form = await request.form()
    file_field = form.get("file")
    if file_field is None or not hasattr(file_field, "read"):
        raise HTTPException(status_code=400, detail="No file field in form data")

    filename = getattr(file_field, "filename", "") or ""
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    paper_id = "trial_" + uuid.uuid4().hex
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"

    content = await file_field.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 50 MB)")
    if not content[:5] == b"%PDF-":
        raise HTTPException(status_code=400, detail="Invalid PDF file")
    with open(pdf_path, "wb") as f:
        f.write(content)

    try:
        raw = extract_pdf(pdf_path, paper_id)
    except Exception as e:
        pdf_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="Failed to parse PDF. Please try a different file.")

    try:
        meta = await extract_metadata(raw.raw_text[:4000])
        title = meta.get("title", filename.replace(".pdf", ""))
        authors = meta.get("authors", [])
    except Exception:
        title = filename.replace(".pdf", "")
        authors = []

    from .models.schemas import ParsedPaper
    paper = ParsedPaper(
        id=paper_id,
        title=title,
        authors=authors,
        raw_text=raw.raw_text,
        figures=raw.figures,
        has_si=False,
        folder="",
        tags=["trial"],
        notes=[],
        cached_analysis={},
    )
    save_paper(paper)
    return paper


@app.post("/api/trial/summary")
async def trial_summary(request: Request, body: dict):
    _check_trial_rate(request)

    from .services.pdf_parser import get_paper, save_paper
    from .services.llm import summarize_paper

    paper_id = body.get("paper_id", "")
    if not paper_id or not paper_id.startswith("trial_"):
        raise HTTPException(status_code=403, detail="Trial summary only for trial papers")
    from .api.papers import _validate_id
    _validate_id(paper_id, "paper_id")

    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    if paper.cached_analysis.get("summary"):
        return paper.cached_analysis["summary"]

    try:
        result = await summarize_paper(paper.raw_text, model_override="claude-haiku-4-5")
        paper.cached_analysis["summary"] = result
        save_paper(paper)
        return result
    except ValueError as e:
        _main_logger.error("Trial summary failed: %s", e)
        raise HTTPException(status_code=500, detail="Summary generation failed. Please try again.")


@app.get("/api/trial/paper/{paper_id}")
async def trial_get_paper(paper_id: str, request: Request):
    _check_trial_rate(request)
    from .api.papers import _validate_id
    _validate_id(paper_id, "paper_id")
    if not paper_id.startswith("trial_"):
        raise HTTPException(status_code=403, detail="Trial access only for trial papers")

    from .services.pdf_parser import get_paper
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return {"id": paper.id, "title": paper.title, "authors": paper.authors}


@app.get("/api/trial/paper/{paper_id}/pdf")
async def trial_get_pdf(paper_id: str, request: Request):
    _check_trial_rate(request)
    from .api.papers import _validate_id
    _validate_id(paper_id, "paper_id")
    if not paper_id.startswith("trial_"):
        raise HTTPException(status_code=403, detail="Trial access only for trial papers")

    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not found")
    return FileResponse(pdf_path, media_type="application/pdf")


# --- Protected routers (auth via per-endpoint Depends(require_auth)) ---

from .api.papers import router as papers_router
from .api.analysis import router as analysis_router
from .api.search import router as search_router
from .api.settings import router as settings_router
from .api.billing import router as billing_router

app.include_router(papers_router)
app.include_router(analysis_router)
app.include_router(search_router)
app.include_router(settings_router)
app.include_router(billing_router)


# ----------------------------------------------------------------
# Workspace endpoints
# ----------------------------------------------------------------

@app.get("/api/workspaces")
async def list_user_workspaces(user_id: str = Depends(require_auth)):
    from .services.db import list_workspaces
    return list_workspaces(user_id)


@app.post("/api/workspaces")
async def save_user_workspace(body: dict, user_id: str = Depends(require_auth)):
    from .services.db import save_workspace
    ws_name = body.get("name", "Untitled Session")[:100]
    result = save_workspace(
        user_id=user_id,
        workspace_id=body.get("id"),
        name=ws_name,
        paper_ids=body.get("paper_ids", [])[:50],
        cross_paper_results=body.get("cross_paper_results", [])[:200],
    )
    if not result:
        raise HTTPException(status_code=500, detail="Failed to save workspace")
    return result


@app.delete("/api/workspaces/{workspace_id}")
async def delete_user_workspace(workspace_id: str, user_id: str = Depends(require_auth)):
    from .services.db import delete_workspace
    delete_workspace(workspace_id, user_id)
    return {"status": "deleted"}


# ----------------------------------------------------------------
# BibTeX export (paid tiers only)
# ----------------------------------------------------------------

def _escape_bibtex(text: str) -> str:
    """Escape BibTeX special characters."""
    for ch in ('&', '%', '#', '_', '~', '^'):
        text = text.replace(ch, f'\\{ch}')
    return text


def _paper_to_bibtex(paper_meta: dict) -> str:
    """Convert a paper metadata dict to a BibTeX entry."""
    pid = paper_meta.get("id", "unknown")
    title = _escape_bibtex(paper_meta.get("title", "Untitled"))
    authors = paper_meta.get("authors", [])
    author_str = _escape_bibtex(" and ".join(authors) if authors else "Unknown")
    safe_id = "".join(c if c.isalnum() else "_" for c in pid)

    return (
        f"@article{{{safe_id},\n"
        f"  title = {{{title}}},\n"
        f"  author = {{{author_str}}},\n"
        f"}}\n"
    )


@app.post("/api/export/bibtex")
async def export_bibtex(body: dict, user_id: str = Depends(require_auth)):
    """Export BibTeX for given paper IDs. Paid tiers only."""
    from .gating import get_user_tier
    from .services.db import list_papers_meta, get_workspace

    tier = get_user_tier(user_id)
    if tier == "free":
        raise HTTPException(status_code=403, detail="BibTeX export requires a paid plan.")

    paper_ids: list[str] = body.get("paper_ids", [])
    folder: str | None = body.get("folder")
    workspace_id: str | None = body.get("workspace_id")

    all_papers = list_papers_meta(user_id)

    if workspace_id:
        ws = get_workspace(workspace_id, user_id)
        if ws:
            ws_ids = set(ws.get("paper_ids", []))
            all_papers = [p for p in all_papers if p["id"] in ws_ids]
    elif folder is not None:
        if folder == "":
            all_papers = [p for p in all_papers if not p.get("folder")]
        else:
            all_papers = [p for p in all_papers if p.get("folder") == folder]
    elif paper_ids:
        id_set = set(paper_ids)
        all_papers = [p for p in all_papers if p["id"] in id_set]

    if not all_papers:
        raise HTTPException(status_code=404, detail="No papers found for export.")

    bibtex = "\n".join(_paper_to_bibtex(p) for p in all_papers)
    return {"bibtex": bibtex, "count": len(all_papers)}
