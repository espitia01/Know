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

_columns_verified = False


def _ensure_columns() -> None:
    """Add analysis_model / fast_model columns to users table if missing."""
    global _columns_verified
    if _columns_verified:
        return
    client = get_db()
    if not client:
        _columns_verified = True
        return
    try:
        row = client.table("users").select("analysis_model").limit(1).execute()
        _columns_verified = True
    except Exception:
        logger.info("Adding analysis_model and fast_model columns to users table")
        try:
            client.postgrest.schema("public")
            client.rpc(
                "exec_sql",
                {"query": "ALTER TABLE users ADD COLUMN IF NOT EXISTS analysis_model text; ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_model text;"},
            ).execute()
            _columns_verified = True
        except Exception:
            logger.warning(
                "Could not auto-add columns. Please run in Supabase SQL Editor:\n"
                "  ALTER TABLE users ADD COLUMN IF NOT EXISTS analysis_model text;\n"
                "  ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_model text;"
            )
            _columns_verified = True


def _get_user_model_prefs(user_id: str) -> tuple[str, str]:
    """Return (analysis_model, fast_model) from the user's DB prefs, falling back to defaults."""
    user = get_user(user_id) or {}
    analysis = user.get("analysis_model") or settings.analysis_model
    fast = user.get("fast_model") or settings.fast_model
    return analysis, fast


def _save_user_model_prefs(user_id: str, analysis_model: str | None = None, fast_model: str | None = None) -> bool:
    """Save model prefs. Returns True on success, False if columns missing."""
    _ensure_columns()
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
        err_str = str(exc)
        if "PGRST204" in err_str or "schema cache" in err_str:
            logger.warning("Model pref columns not found in users table — save skipped")
            return False
        logger.error("Failed to save model prefs for %s: %s", user_id, exc)
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
    allowed = get_allowed_models(user_id)

    if update.analysis_model is not None:
        if update.analysis_model not in allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Model '{update.analysis_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
            )

    if update.fast_model is not None:
        if update.fast_model not in allowed:
            raise HTTPException(
                status_code=403,
                detail=f"Model '{update.fast_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
            )

    ok = True
    if update.analysis_model:
        ok = _save_user_model_prefs(user_id, analysis_model=update.analysis_model) and ok
    if update.fast_model:
        ok = _save_user_model_prefs(user_id, fast_model=update.fast_model) and ok

    if not ok:
        raise HTTPException(
            status_code=500,
            detail="Could not save model preferences. Please add the columns to the users table. "
                   "Run this SQL in Supabase SQL Editor:\n"
                   "ALTER TABLE users ADD COLUMN IF NOT EXISTS analysis_model text;\n"
                   "ALTER TABLE users ADD COLUMN IF NOT EXISTS fast_model text;\n"
                   "Then notify PostgREST to reload the schema cache by calling: NOTIFY pgrst, 'reload schema';",
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
