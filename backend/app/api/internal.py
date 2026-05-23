"""Server-to-server endpoints for the Next.js streaming routes.

These endpoints exist purely so the migrated AI SDK routes on Vercel can:

  * Pull paper context (raw text, title, authors) on a per-call basis.
  * Atomically reserve and release tier/usage caps via the existing
    ``gating.reserve_usage`` / ``release_usage`` machinery — keeping
    Python the single source of truth for gating semantics.
  * Fetch a figure PNG to feed to a vision model.
  * Persist the final assembled object to ``cached_analysis`` after a
    stream completes.
  * Run the daily trial cleanup as a Vercel Cron callback.

Authentication is a shared bearer token (``KNOW_INTERNAL_BACKEND_TOKEN``)
compared in constant time. There is no Clerk JWT path here: callers are
*services*, not browsers, and the Next.js routes already authenticated
the user via Clerk before relaying ``user_id`` to us. CORS does not apply
because the browser never hits this router directly — if you ever see
``Origin`` set on a request here, that's a misconfiguration.

Surface kept intentionally small: every endpoint maps 1:1 to an
existing Python helper. Do not let LLM-call logic leak into this file —
streaming and prompts live in the Next.js routes.
"""

from __future__ import annotations

import hmac
import logging
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, Header, HTTPException
from fastapi.responses import FileResponse, Response

from ..config import settings
from ..gating import enforce_model, reserve_usage, release_usage, get_usage_multiplier, resolve_deep_analysis, get_user_tier

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/internal", tags=["internal"])


_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_id(value: str, name: str = "id") -> str:
    if not value or not _SAFE_ID_RE.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {name}")
    return value


def require_internal_bearer(authorization: str = Header(default="")) -> None:
    """Reject anything that isn't ``Authorization: Bearer <KNOW_INTERNAL_BACKEND_TOKEN>``.

    Constant-time compare so we don't leak the token length via a timing
    side-channel. If the token isn't configured at all we fail closed —
    we'd rather 503 the Next.js route than silently accept anonymous
    server-to-server calls.
    """
    expected = settings.internal_backend_token or ""
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Internal endpoint disabled: KNOW_INTERNAL_BACKEND_TOKEN not configured.",
        )
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="Missing internal bearer")
    presented = authorization[len(prefix):]
    if not hmac.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="Invalid internal bearer")


# ----------------------------------------------------------------
# Paper context
# ----------------------------------------------------------------


@router.get("/paper/{paper_id}/text", dependencies=[Depends(require_internal_bearer)])
async def internal_paper_text(paper_id: str, user_id: str):
    """Return the sanitized paper context the Next.js streaming routes need.

    Owner-checked: if the paper isn't owned by ``user_id`` we 404 (never
    leak existence). The sanitization mirrors the per-prompt cap used in
    Python's old streaming routes — the Next.js side may still trim
    further, but we cap once here so a 100 MB raw_text doesn't fly across
    the wire on every keystroke.
    """
    _validate_id(paper_id, "paper_id")
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")

    from ..services.db import get_paper_meta
    if not get_paper_meta(paper_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Paper not found")

    from ..services.pdf_parser import get_paper, paper_prompt_text
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    raw_text = paper_prompt_text(paper)
    if len(raw_text) > 200_000:
        raw_text = raw_text[:200_000]

    return {
        "id": paper.id,
        "title": paper.title or "",
        "authors": paper.authors or [],
        "raw_text": raw_text,
        "has_si": bool(paper.has_si),
    }


# ----------------------------------------------------------------
# User model preferences (Settings → analysis / fast model)
# ----------------------------------------------------------------


@router.get("/user/{user_id}/allowed-models", dependencies=[Depends(require_internal_bearer)])
async def internal_user_allowed_models(user_id: str):
    """Return tier allow-list for per-request model overrides on Next.js streams."""
    _validate_id(user_id, "user_id")
    from ..gating import get_allowed_models

    return {"allowed": get_allowed_models(user_id)}


@router.get("/user/{user_id}/models", dependencies=[Depends(require_internal_bearer)])
async def internal_user_models(user_id: str):
    """Return tier-enforced model slugs for migrated Next.js stream routes.

    Mirrors ``resolve_analysis_model`` / ``resolve_fast_model`` so streaming
    calls use the same models as batch Python endpoints and Settings UI.
    """
    _validate_id(user_id, "user_id")
    from ..gating import resolve_analysis_model, resolve_fast_model

    return {
        "analysis_model": resolve_analysis_model(user_id),
        "fast_model": resolve_fast_model(user_id),
    }


@router.get("/user/{user_id}/preferences", dependencies=[Depends(require_internal_bearer)])
async def internal_user_preferences(user_id: str):
    """Model prefs + tier + deep-analysis flag for Next.js stream routes."""
    _validate_id(user_id, "user_id")
    from ..gating import resolve_analysis_model, resolve_fast_model

    return {
        "analysis_model": resolve_analysis_model(user_id),
        "fast_model": resolve_fast_model(user_id),
        "tier": get_user_tier(user_id),
        "deep_analysis": resolve_deep_analysis(user_id),
        "usage_multiplier": get_usage_multiplier(user_id),
    }


# ----------------------------------------------------------------
# Usage reservation / release
# ----------------------------------------------------------------


@router.post("/usage/reserve", dependencies=[Depends(require_internal_bearer)])
async def internal_usage_reserve(body: dict = Body(...)):
    """Reserve one logical call against the user's tier caps.

    Body: ``{ user_id, paper_id, kind, model?, count?, record_daily? }``
    where ``kind`` is "qa" / "selection" / "summary" / "figure". A
    successful response returns the same token shape ``release_usage``
    expects — the Next.js side stores it for the duration of the stream
    and posts it back to ``/usage/release`` if the stream fails.
    """
    user_id = (body.get("user_id") or "").strip()
    paper_id = (body.get("paper_id") or "").strip()
    kind = (body.get("kind") or "").strip()
    model = body.get("model")
    count = int(body.get("count") or 1)
    record_daily = bool(body.get("record_daily", True))
    # Callers can opt out of the deep multiplier when they've already applied
    # it client-side (e.g. a future batched stream that pre-scales count by
    # the question count × deep factor). Default is False so today's Next.js
    # streams keep getting the multiplier applied here.
    apply_deep_multiplier = bool(body.get("apply_deep_multiplier", True))

    if not user_id or not kind:
        raise HTTPException(status_code=400, detail="Missing user_id or kind")
    _validate_id(paper_id, "paper_id")

    if model:
        model = enforce_model(user_id, model)

    deep_kinds = {"qa", "selection", "summary", "figure"}
    if apply_deep_multiplier and kind in deep_kinds:
        count = count * get_usage_multiplier(user_id)

    token = reserve_usage(
        user_id=user_id,
        paper_id=paper_id,
        action=kind,
        model=model,
        count=count,
        record_daily=record_daily,
    )
    return {"token": token, "model": model}


@router.post("/usage/release", dependencies=[Depends(require_internal_bearer)])
async def internal_usage_release(body: dict = Body(...)):
    """Compensating release for a prior /usage/reserve. Always returns 200.

    We never raise here — release is best-effort and the Python side
    already silences DB-blip exceptions in ``release_usage``. Returning
    200 lets the Next.js ``after()`` callback proceed.
    """
    token = body.get("token")
    if not isinstance(token, dict):
        return {"ok": False, "reason": "no token"}
    release_usage(token)
    return {"ok": True}


# ----------------------------------------------------------------
# Figure PNG (vision)
# ----------------------------------------------------------------


@router.get(
    "/figure/{paper_id}/{figure_id}",
    dependencies=[Depends(require_internal_bearer)],
)
async def internal_figure_png(paper_id: str, figure_id: str, user_id: str):
    """Return raw PNG bytes for a figure. Owner-checked.

    The Next.js vision route fetches this once per analysis call and
    base64-encodes it before sending to Anthropic. We could mirror to
    Supabase Storage and hand back a signed URL instead, but that adds a
    deploy dependency we don't need yet.
    """
    _validate_id(paper_id, "paper_id")
    _validate_id(figure_id, "figure_id")
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")

    from ..services.db import get_paper_meta
    if not get_paper_meta(paper_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Paper not found")

    from ..services.pdf_parser import get_figure_path
    from ..services import storage as cloud_storage

    fig_path = get_figure_path(paper_id, figure_id)
    if fig_path:
        return FileResponse(str(fig_path), media_type="image/png")

    # Mirror the public GET /figures/{id} route: on multi-instance deploys the
    # PNG may exist only in Supabase after upload or re-extract on another node.
    fig_bytes = cloud_storage.download_file(user_id, f"{paper_id}/figures/{figure_id}.png")
    if fig_bytes:
        local_dir = settings.papers_dir / paper_id / "figures"
        local_dir.mkdir(parents=True, exist_ok=True)
        cached = local_dir / f"{figure_id}.png"
        try:
            cached.write_bytes(fig_bytes)
        except OSError:
            logger.warning(
                "Could not cache figure %s/%s locally; streaming from memory",
                paper_id,
                figure_id,
                exc_info=True,
            )
            return Response(content=fig_bytes, media_type="image/png")
        return FileResponse(str(cached), media_type="image/png")

    raise HTTPException(status_code=404, detail="Figure not found")


# ----------------------------------------------------------------
# Cached analysis upsert (called after a stream completes)
# ----------------------------------------------------------------


@router.post("/cached-analysis/upsert", dependencies=[Depends(require_internal_bearer)])
async def internal_cached_analysis_upsert(body: dict = Body(...)):
    """Persist a final assembled stream result into ``cached_analysis``.

    Body: ``{ user_id, paper_id, key, value }``. ``key`` is one of
    "summary" / "selections" (appended-capped) / "figure_qa:<fig_id>" /
    etc. We mirror the same ``mutate_local_paper`` + ``append_capped``
    helpers the Python routes use today, so cache layout stays identical
    across migrated and unmigrated paths.
    """
    user_id = (body.get("user_id") or "").strip()
    paper_id = (body.get("paper_id") or "").strip()
    key = (body.get("key") or "").strip()
    value = body.get("value")

    if not user_id or not key or value is None:
        raise HTTPException(status_code=400, detail="Missing user_id, key, or value")
    _validate_id(paper_id, "paper_id")

    from ..services.db import get_paper_meta
    if not get_paper_meta(paper_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Paper not found")

    from ..services.pdf_parser import mutate_paper, append_capped

    appended = key in {"selections", "qa_history", "figure_analyses", "qa_sessions"}

    def _apply(p):
        if appended:
            append_capped(p.cached_analysis, key, value)
        else:
            p.cached_analysis[key] = value

    try:
        mutate_paper(paper_id, user_id, _apply)
    except Exception:
        logger.exception("cached-analysis upsert failed for %s/%s", paper_id, key)
        raise HTTPException(status_code=500, detail="Failed to persist cached analysis")
    return {"ok": True, "appended": appended}


# ----------------------------------------------------------------
# Retrieval (Track D)
# ----------------------------------------------------------------


@router.post("/retrieve", dependencies=[Depends(require_internal_bearer)])
async def internal_retrieve(body: dict = Body(...)):
    """Embed query and return top matching paper chunks."""
    user_id = (body.get("user_id") or "").strip()
    paper_ids = body.get("paper_ids") or []
    query = (body.get("query") or "").strip()
    max_chars = int(body.get("max_chars") or 8000)
    top_k = int(body.get("top_k") or 8)

    if not user_id or not query or not isinstance(paper_ids, list):
        raise HTTPException(status_code=400, detail="Missing user_id, query, or paper_ids")

    from ..services.db import get_paper_meta
    validated: list[str] = []
    for pid in paper_ids[:20]:
        if not isinstance(pid, str):
            continue
        _validate_id(pid, "paper_id")
        if get_paper_meta(pid, user_id=user_id):
            validated.append(pid)
    if not validated:
        raise HTTPException(status_code=404, detail="No accessible papers")

    from ..services.retrieval import retrieve_for_paper

    try:
        context, hits = await retrieve_for_paper(
            validated, query, max_chars=max_chars, top_k=top_k,
        )
    except Exception:
        logger.exception("internal retrieve failed")
        return {"context": "", "hits": [], "passage_count": 0}

    return {"context": context, "hits": hits, "passage_count": len(hits)}


@router.post("/papers/{paper_id}/embed", dependencies=[Depends(require_internal_bearer)])
async def internal_embed_paper(paper_id: str, body: dict = Body(...)):
    """Chunk + embed a paper (post-upload or backfill)."""
    _validate_id(paper_id, "paper_id")
    user_id = (body.get("user_id") or "").strip()
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")

    from ..services.db import get_paper_meta
    if not get_paper_meta(paper_id, user_id=user_id):
        raise HTTPException(status_code=404, detail="Paper not found")

    from ..services.pdf_parser import get_paper
    from ..services.retrieval import embed_paper
    from ..services.embeddings import EmbeddingProviderError

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        n = await embed_paper(paper_id, user_id, paper.raw_text or "")
    except EmbeddingProviderError as exc:
        raise HTTPException(status_code=503, detail={"code": exc.code, "message": exc.message})
    except Exception:
        logger.exception("embed failed for %s", paper_id)
        raise HTTPException(status_code=500, detail="Embedding failed")

    return {"ok": True, "chunks": n}


# ----------------------------------------------------------------
# Trial cleanup (called by Vercel Cron)
# ----------------------------------------------------------------


@router.post("/admin/cleanup-trial", dependencies=[Depends(require_internal_bearer)])
async def internal_cleanup_trial(body: dict = Body(default={})):
    """Remove trial papers older than ``max_age_hours`` (default 2h).

    Mirrors the inline logic from ``main._trial_cleanup_loop`` so we can
    drive cleanup from a Vercel Cron schedule. The in-process loop will
    be retired in stage 6 once the cron is verified running.
    """
    max_age_hours = int(body.get("max_age_hours") or 2)
    now = time.time()
    cutoff = now - max_age_hours * 3600

    removed_db = 0
    try:
        from ..services.db import get_db
        client = get_db()
        if client:
            res = client.rpc("cleanup_trial_data", {"max_age_hours": max_age_hours}).execute()
            removed_db = int(res.data or 0) if res else 0
    except Exception:
        logger.exception("cleanup_trial_data RPC failed")

    removed_disk = 0
    try:
        for p in settings.papers_dir.iterdir():
            if not p.name.startswith("trial_"):
                continue
            try:
                if p.stat().st_mtime < cutoff:
                    if p.is_dir():
                        shutil.rmtree(p)
                    else:
                        p.unlink()
                    removed_disk += 1
            except Exception:
                logger.debug("Trial cleanup skip %s", p.name, exc_info=True)
    except FileNotFoundError:
        pass

    return {"ok": True, "removed_db": removed_db, "removed_disk": removed_disk}


# ----------------------------------------------------------------
# Trial rate-limit RPC proxy (used by KV-backed limiter as an authoritative check)
# ----------------------------------------------------------------


@router.post("/trial/rate-check", dependencies=[Depends(require_internal_bearer)])
async def internal_trial_rate_check(body: dict = Body(...)):
    """Authoritative trial rate-limit check via the existing Supabase RPC.

    Lives on the Python side because the RPC exists in Supabase already
    and the gating logic is here. The Next.js KV-backed limiter consults
    this when it wants to confirm before allowing an anonymous LLM call.
    """
    ip = (body.get("ip") or "").strip()
    max_requests = int(body.get("max_requests") or 5)
    window_seconds = int(body.get("window_seconds") or 3600)
    if not ip:
        raise HTTPException(status_code=400, detail="Missing ip")

    from ..services.db import get_db
    client = get_db()
    if not client:
        return {"ok": False, "reason": "db_unavailable"}
    try:
        res = client.rpc(
            "check_trial_rate",
            {"p_ip": ip, "p_max_requests": max_requests, "p_window_seconds": window_seconds},
        ).execute()
        allowed = bool(res.data) if res is not None else False
        return {"ok": True, "allowed": allowed}
    except Exception:
        logger.exception("trial rate-check RPC failed")
        return {"ok": False, "reason": "rpc_failed"}
