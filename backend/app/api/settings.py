"""API routes for settings management."""

from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..models.schemas import SettingsResponse, SettingsUpdate
from ..auth import require_auth
from ..gating import get_allowed_models, enforce_model
from ..services.db import get_user, get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])
logger = logging.getLogger(__name__)

# NOTE: M1 — the previous `_ensure_columns` helper used `exec_sql` to
# self-heal the users table schema at runtime. That coupled runtime code to
# having DDL privileges (dangerous in managed DBs) and silently hid missing
# migrations. Schema now lives in migration `009_hardening.sql` and this
# module assumes it has been applied.


def _get_user_model_prefs(user_id: str) -> tuple[str, str]:
    """Return (analysis_model, fast_model) from the user's DB prefs, falling back to defaults."""
    user = get_user(user_id) or {}
    analysis = user.get("analysis_model") or settings.analysis_model
    fast = user.get("fast_model") or settings.fast_model
    return analysis, fast


def _save_user_model_prefs(user_id: str, analysis_model: str | None = None, fast_model: str | None = None) -> bool:
    """Save model prefs. Returns True on success, False on DB failure.

    Caller never sees the raw exception string: M11 removed the SQL-hint
    response that leaked PostgREST error codes and DDL snippets to clients.
    A 500 with a generic message is all the client gets; operators read
    the structured server log.
    """
    client = get_db()
    if not client:
        return False
    updates: dict = {}
    if analysis_model is not None:
        updates["analysis_model"] = analysis_model
    if fast_model is not None:
        updates["fast_model"] = fast_model
    if not updates:
        return True
    try:
        client.table("users").update(updates).eq("user_id", user_id).execute()
        return True
    except Exception as exc:
        logger.error("Failed to save model prefs for %s: %s", user_id, exc.__class__.__name__)
        return False


@router.get("", response_model=SettingsResponse)
async def get_settings(user_id: str = Depends(require_auth)):
    analysis, fast = _get_user_model_prefs(user_id)
    enforced_analysis = enforce_model(user_id, analysis)
    enforced_fast = enforce_model(user_id, fast)
    return SettingsResponse(
        has_anthropic_key=True,
        analysis_model=enforced_analysis,
        fast_model=enforced_fast,
    )


@router.put("", response_model=SettingsResponse)
async def update_settings(update: SettingsUpdate, user_id: str = Depends(require_auth)):
    """Save the user's preferred analysis/fast model.

    L7: the old behavior validated against ``get_allowed_models`` but stored
    whatever the client sent. If the set of allowed models for a tier
    changed server-side between the GET and PUT, a stale value could
    linger in the DB. We now pass each incoming model through
    ``enforce_model`` — the same function the runtime uses to pick a model
    for LLM calls — so the stored value is always one this tier is
    currently authorized to use. If a client sends an unavailable model
    we return 403 up front (so the UX is honest) and never persist it.

    M11: failure responses no longer embed SQL DDL or PostgREST error
    codes. The client just gets a generic 500 and the operator reads the
    log for the specific failure class.
    """
    allowed = get_allowed_models(user_id)

    if update.analysis_model is not None and update.analysis_model not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"Model '{update.analysis_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
        )

    if update.fast_model is not None and update.fast_model not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"Model '{update.fast_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
        )

    ok = True
    if update.analysis_model:
        normalized = enforce_model(user_id, update.analysis_model)
        ok = _save_user_model_prefs(user_id, analysis_model=normalized) and ok
    if update.fast_model:
        normalized = enforce_model(user_id, update.fast_model)
        ok = _save_user_model_prefs(user_id, fast_model=normalized) and ok

    if not ok:
        raise HTTPException(
            status_code=500,
            detail="Could not save model preferences. Please try again later.",
        )

    analysis, fast = _get_user_model_prefs(user_id)
    return SettingsResponse(
        has_anthropic_key=True,
        analysis_model=analysis,
        fast_model=fast,
    )


@router.get("/models")
async def list_models(user_id: str = Depends(require_auth)):
    return {"models": get_allowed_models(user_id)}
