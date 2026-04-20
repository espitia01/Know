import os
import re
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
                    except Exception as e:
                        _main_logger.debug("Trial cleanup skip %s: %s", p.name, e)
        except Exception as e:
            _main_logger.warning("Trial cleanup failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_trial_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="Know", description="Pedagogical Paper Enhancement Platform", lifespan=lifespan)

MAX_JSON_BODY = 2 * 1024 * 1024  # 2 MB


@app.middleware("http")
async def limit_json_body(request: Request, call_next):
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.body()
        if len(body) > MAX_JSON_BODY:
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=413, content={"detail": "Request body too large"})
    return await call_next(request)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    _main_logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


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

cors_regex = os.environ.get("KNOW_CORS_REGEX", "")
if cors_regex:
    import re as _re
    try:
        _re.compile(cors_regex)
    except _re.error as _err:
        _main_logger.error("Invalid KNOW_CORS_REGEX '%s': %s — ignoring", cors_regex, _err)
        cors_regex = ""

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=cors_regex or None,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/user/me")
async def get_current_user(user_id: str = Depends(require_auth)):
    """Return current user info including tier.

    Stripe webhooks are the **single writer** for ``users.tier`` in steady
    state. This endpoint used to sync tier state from Stripe on every read,
    which raced with webhook writes and could silently upgrade/downgrade
    users (especially while a webhook was still in-flight).

    Now we only reconcile as a fallback:
        * tier=free but an active subscription exists → upgrade once. This
          covers the brief window between checkout success and the
          ``checkout.session.completed`` webhook.
        * tier!=free but no active subscription exists → do NOT downgrade
          here. The webhook (``customer.subscription.deleted``) is the
          source of truth for cancellations; downgrading on an API 5xx
          or a stale Stripe read would be catastrophic for paying users.

    Read-only fields like ``cancel_at_period_end`` still come from Stripe
    because the DB doesn't persist them.
    """
    from .services.db import get_or_create_user, update_user_tier
    user = get_or_create_user(user_id)

    customer_id = user.get("stripe_customer_id")
    tier = user.get("tier", "free")
    cancel_at_period_end = False
    cancel_at = None

    if customer_id:
        try:
            from .api.billing import PRICE_TO_TIER
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
                if tier == "free":
                    price_id = sub["items"]["data"][0]["price"]["id"]
                    resolved = PRICE_TO_TIER.get(price_id)
                    if resolved and resolved != "free":
                        update_user_tier(user_id, resolved)
                        tier = resolved
                        _main_logger.info(
                            "Backfilled tier for %s from Stripe (%s) — "
                            "webhook likely still in flight",
                            user_id, resolved,
                        )
            # Intentionally NOT downgrading here: the webhook owns the
            # downgrade path. A transient Stripe list failure (5xx, network
            # blip, list pagination edge case) must not kick a paying user
            # to free mid-session.
        except Exception as e:
            _main_logger.warning("Stripe sync for user %s failed: %s", user_id, e.__class__.__name__)

    return {
        "user_id": user.get("user_id", user_id),
        "tier": tier,
        "paper_count": user.get("paper_count", 0),
        "has_billing": bool(customer_id and tier != "free"),
        "cancel_at_period_end": cancel_at_period_end,
        "cancel_at": cancel_at,
    }


_PAPER_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


@app.get("/api/usage/{paper_id}")
async def get_paper_usage(paper_id: str, user_id: str = Depends(require_auth)):
    """Return per-paper usage counts and limits for the current user.

    M10: validate ``paper_id`` and verify ownership before returning counts.
    Without this a caller could probe arbitrary IDs (or path-traversal-like
    strings) to learn whether specific papers exist in the system. We now
    enforce the same regex used in ``/api/papers/*`` and short-circuit with
    a 404 if the paper isn't owned by the caller.
    """
    if not _PAPER_ID_RE.match(paper_id or ""):
        raise HTTPException(status_code=400, detail="Invalid paper_id")

    from .services.db import get_usage_count, get_paper_meta
    from .gating import get_user_tier, TIER_LIMITS

    if not get_paper_meta(paper_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Paper not found")

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


@app.get("/api/usage")
async def get_account_usage(user_id: str = Depends(require_auth)):
    """Return account-wide usage counts and tier limits for the current user."""
    from .services.db import get_user, get_daily_api_count
    from .gating import get_user_tier, TIER_LIMITS, get_per_model_daily_usage

    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])

    user = get_user(user_id) or {}
    paper_count = user.get("paper_count", 0)

    try:
        daily_used = get_daily_api_count(user_id)
    except Exception:
        daily_used = 0

    try:
        per_model = get_per_model_daily_usage(user_id)
    except Exception:
        per_model = []

    return {
        "tier": tier,
        "papers_used": paper_count,
        "papers_limit": limits.get("max_papers", -1),
        "daily_api_used": daily_used,
        "daily_api_limit": limits.get("daily_api_calls", -1),
        "qa_per_paper_limit": limits.get("qa_per_paper", -1),
        "selections_per_paper_limit": limits.get("selections_per_paper", -1),
        "per_model_usage": per_model,
    }


# --- Trial endpoints (no auth, rate-limited by IP via Supabase) ---

TRIAL_RATE_LIMIT = 5
TRIAL_WINDOW = 3600


def _check_trial_rate(request: Request):
    """Enforce IP-based rate limiting on unauthenticated trial endpoints.

    C3: Previously, if the Supabase RPC raised (DB down, migration missing,
    etc.) we silently fell through to an in-memory fallback. The fallback
    is per-process, so a restart/redeploy wiped counters and a cluster of
    workers meant each had its own quota — a trivial abuse path for
    unauthenticated endpoints. We now:

      * keep the in-memory deque ONLY as a last resort when Supabase isn't
        configured at all (dev / self-host),
      * fail closed (503) when Supabase IS configured but the RPC call
        fails. We'd rather reject a legit user with a retryable 503 than
        hand a free-LLM-calls-per-IP oracle to attackers.
    """
    ip = request.client.host if request.client else "unknown"
    if ip in ("127.0.0.1", "::1", "unknown"):
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            ip = forwarded.split(",")[0].strip()
    if not ip or ip == "unknown":
        raise HTTPException(status_code=429, detail="Cannot determine client IP for rate limiting.")

    from .services.db import get_db
    client = get_db()
    if client:
        try:
            res = client.rpc("check_trial_rate", {
                "p_ip": ip,
                "p_max_requests": TRIAL_RATE_LIMIT,
                "p_window_seconds": TRIAL_WINDOW,
            }).execute()
        except Exception as e:
            _main_logger.error("Trial rate-limit RPC failed, failing closed: %s", e.__class__.__name__)
            raise HTTPException(
                status_code=503,
                detail="Trial rate limiter temporarily unavailable. Please retry shortly.",
            )
        if res and res.data is False:
            raise HTTPException(status_code=429, detail="Trial rate limit exceeded. Sign up to continue.")
        return

    # Only reachable in local dev / self-host where Supabase isn't configured.
    now = time.time()
    if ip not in _trial_fallback:
        if len(_trial_fallback) > 10000:
            oldest = sorted(_trial_fallback, key=lambda k: _trial_fallback[k][-1] if _trial_fallback[k] else 0)[:5000]
            for k in oldest:
                del _trial_fallback[k]
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
    return {"id": paper.id, "title": paper.title, "authors": paper.authors, "figures": [f.model_dump() for f in paper.figures]}


@app.post("/api/trial/summary")
async def trial_summary(request: Request, body: dict):
    _check_trial_rate(request)

    from .services.pdf_parser import get_paper, save_paper
    from .services.llm import summarize_paper

    paper_id = body.get("paper_id", "")
    if not paper_id or not paper_id.startswith("trial_"):
        raise HTTPException(status_code=400, detail="Trial summary only for trial papers")
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
        raise HTTPException(status_code=503, detail="Summary generation failed. Please try again.")


@app.get("/api/trial/paper/{paper_id}")
async def trial_get_paper(paper_id: str, request: Request):
    _check_trial_rate(request)
    from .api.papers import _validate_id
    _validate_id(paper_id, "paper_id")
    if not paper_id.startswith("trial_"):
        raise HTTPException(status_code=400, detail="Trial access only for trial papers")

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
        raise HTTPException(status_code=400, detail="Trial access only for trial papers")

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

def _require_paid_tier(user_id: str) -> str:
    """Reject free-tier users from workspace and export features."""
    from .gating import get_user_tier
    tier = get_user_tier(user_id)
    if tier == "free":
        raise HTTPException(status_code=403, detail="Workspaces require a paid plan. Upgrade to save sessions.")
    return tier


def _require_multi_paper(user_id: str) -> str:
    """Workspaces save multi-paper sessions, which are only useful with
    cross-paper Q&A. Gate them on the `multi-qa` capability so tiers without
    cross-paper analysis don't accumulate sessions they can't meaningfully use.
    """
    from .gating import check_feature_access
    return check_feature_access(user_id, "multi-qa")


@app.get("/api/workspaces")
async def list_user_workspaces(user_id: str = Depends(require_auth)):
    _require_multi_paper(user_id)
    from .services.db import list_workspaces
    return list_workspaces(user_id)


_MAX_WS_NAME = 100
_MAX_WS_PAPERS = 50
_MAX_WS_RESULTS = 200
_MAX_WS_RESULT_ITEM = 50_000  # chars per cross-paper result item (JSON-serialized)


def _cap_cross_paper_results(items: list) -> list:
    """M13: cap each cross-paper result so one runaway entry can't blow up
    the ``workspaces.cross_paper_results`` JSONB column. We serialize each
    item to JSON to measure its real size in the stored form, then truncate
    long string fields in-place.
    """
    import json as _json
    capped: list = []
    for item in items[:_MAX_WS_RESULTS]:
        try:
            serialized = _json.dumps(item, ensure_ascii=False)
        except Exception:
            continue
        if len(serialized) <= _MAX_WS_RESULT_ITEM:
            capped.append(item)
            continue
        if isinstance(item, dict):
            trimmed: dict = {}
            for k, v in item.items():
                if isinstance(v, str) and len(v) > _MAX_WS_RESULT_ITEM // 4:
                    trimmed[k] = v[: _MAX_WS_RESULT_ITEM // 4]
                else:
                    trimmed[k] = v
            capped.append(trimmed)
        else:
            capped.append(str(item)[:_MAX_WS_RESULT_ITEM])
    return capped


@app.post("/api/workspaces")
async def save_user_workspace(body: dict, user_id: str = Depends(require_auth)):
    """Create or update a workspace.

    M9: an existing ``id`` is now verified to belong to the caller before
    we proceed. Previously ``save_workspace`` would happily UPDATE any
    row matching the id (RLS caught this at the DB layer, but the API
    still looked like it succeeded on a cross-user id from the caller's
    perspective). We now return 404 so clients don't get false positives.

    M13: every field that lands in JSONB has a hard cap, and individual
    ``cross_paper_results`` entries are trimmed so one huge answer can't
    push the row over Postgres's row size limits.
    """
    _require_multi_paper(user_id)
    from .services.db import save_workspace, get_paper_meta, get_workspace
    from .api.papers import _validate_id

    ws_id = body.get("id")
    if ws_id:
        if not isinstance(ws_id, str):
            raise HTTPException(status_code=400, detail="Invalid workspace id")
        existing = get_workspace(ws_id, user_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Workspace not found")

    raw_name = body.get("name", "Untitled Session")
    if not isinstance(raw_name, str):
        raw_name = "Untitled Session"
    ws_name = raw_name[:_MAX_WS_NAME]

    paper_ids = body.get("paper_ids", [])
    if not isinstance(paper_ids, list):
        paper_ids = []
    validated_ids: list[str] = []
    for pid in paper_ids[:_MAX_WS_PAPERS]:
        if not isinstance(pid, str):
            continue
        _validate_id(pid, "paper_id")
        if get_paper_meta(pid, user_id=user_id):
            validated_ids.append(pid)

    raw_results = body.get("cross_paper_results", [])
    if not isinstance(raw_results, list):
        raw_results = []
    capped_results = _cap_cross_paper_results(raw_results)

    result = save_workspace(
        user_id=user_id,
        workspace_id=ws_id,
        name=ws_name,
        paper_ids=validated_ids,
        cross_paper_results=capped_results,
    )
    if not result:
        raise HTTPException(status_code=500, detail="Failed to save workspace")
    return result


@app.delete("/api/workspaces/{workspace_id}")
async def delete_user_workspace(workspace_id: str, user_id: str = Depends(require_auth)):
    """M9: verify ownership before delete so a stray id returns 404 instead
    of silently no-op'ing."""
    _require_multi_paper(user_id)
    from .services.db import delete_workspace, get_workspace
    if not get_workspace(workspace_id, user_id):
        raise HTTPException(status_code=404, detail="Workspace not found")
    delete_workspace(workspace_id, user_id)
    return {"status": "deleted"}


# ----------------------------------------------------------------
# BibTeX export (paid tiers only)
# ----------------------------------------------------------------

def _escape_bibtex(text: str) -> str:
    """Escape BibTeX special characters."""
    text = text.replace('\\', '\\textbackslash{}')
    for ch in ('&', '%', '#', '_', '~', '^', '$'):
        text = text.replace(ch, f'\\{ch}')
    text = text.replace('{', '\\{').replace('}', '\\}')
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
