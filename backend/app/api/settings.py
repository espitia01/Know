"""API routes for settings management."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..models.schemas import SettingsResponse, SettingsUpdate
from ..auth import require_auth
from ..gating import ALL_MODELS, get_allowed_models, enforce_model
from ..services.db import get_user, get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _get_user_model_prefs(user_id: str) -> tuple[str, str]:
    """Return (analysis_model, fast_model) from the user's DB prefs, falling back to defaults."""
    user = get_user(user_id) or {}
    analysis = user.get("analysis_model") or settings.analysis_model
    fast = user.get("fast_model") or settings.fast_model
    return analysis, fast


def _save_user_model_prefs(user_id: str, analysis_model: str | None = None, fast_model: str | None = None) -> None:
    client = get_db()
    if not client:
        return
    updates: dict = {}
    if analysis_model is not None:
        updates["analysis_model"] = analysis_model
    if fast_model is not None:
        updates["fast_model"] = fast_model
    if updates:
        try:
            client.table("users").update(updates).eq("user_id", user_id).execute()
        except Exception as exc:
            import logging
            logging.getLogger(__name__).error("Failed to save model prefs for %s: %s", user_id, exc)
            raise


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

    try:
        if update.analysis_model is not None:
            if update.analysis_model not in allowed:
                raise HTTPException(
                    status_code=403,
                    detail=f"Model '{update.analysis_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
                )
            _save_user_model_prefs(user_id, analysis_model=update.analysis_model)

        if update.fast_model is not None:
            if update.fast_model not in allowed:
                raise HTTPException(
                    status_code=403,
                    detail=f"Model '{update.fast_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
                )
            _save_user_model_prefs(user_id, fast_model=update.fast_model)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to save model preferences. The 'analysis_model' and 'fast_model' columns may need to be added to the users table. Error: {exc}",
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
