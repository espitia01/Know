"""API routes for settings management."""

from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..models.schemas import SettingsResponse, SettingsUpdate
from ..auth import require_auth
from ..gating import get_allowed_models, enforce_model, canonicalize_model, get_user_tier, TIER_LIMITS, DEEP_USAGE_MULTIPLIER, resolve_deep_analysis
from ..services.appearance import clamp_background_opacity, normalize_background_preset
from ..services.db import get_user, get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])
logger = logging.getLogger(__name__)

# NOTE: M1 — the previous `_ensure_columns` helper used `exec_sql` to
# self-heal the users table schema at runtime. That coupled runtime code to
# having DDL privileges (dangerous in managed DBs) and silently hid missing
# migrations. Schema now lives in migration `009_hardening.sql` and this
# module assumes it has been applied.


def _get_user_model_prefs(user_id: str) -> tuple[str, str]:
    """Return (analysis_model, fast_model) from the user's DB prefs, falling back to defaults.

    Each stored value is canonicalized so stale aliases that were written
    before a model ID change (e.g. ``claude-opus-4``) don't leak down to
    the LLM call and produce an Anthropic 4xx for "unknown model". The
    rewrite is silent: ``update_settings`` opportunistically persists the
    canonical form the next time the user saves.
    """
    user = get_user(user_id) or {}
    analysis = canonicalize_model(user.get("analysis_model")) or settings.analysis_model
    fast = canonicalize_model(user.get("fast_model")) or settings.fast_model
    return analysis, fast


def _get_user_background_prefs(user_id: str) -> tuple[str | None, float | None]:
    user = get_user(user_id) or {}
    preset = normalize_background_preset(user.get("background_preset"))
    opacity = clamp_background_opacity(user.get("background_opacity"))
    return preset, opacity


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


def _save_user_background_prefs(
    user_id: str,
    *,
    background_preset: str | None = None,
    background_opacity: float | None = None,
) -> bool:
    """Persist appearance prefs. Each call writes only the supplied field so
    the route's two-step preset/opacity update doesn't clobber the other."""
    client = get_db()
    if not client:
        return False
    updates: dict = {}
    if background_preset is not None:
        updates["background_preset"] = background_preset
    if background_opacity is not None:
        updates["background_opacity"] = float(background_opacity)
    if not updates:
        return True
    try:
        client.table("users").update(updates).eq("user_id", user_id).execute()
        return True
    except Exception as exc:
        logger.error("Failed to save background prefs for %s: %s", user_id, exc.__class__.__name__)
        return False


def _save_user_deep_analysis(user_id: str, enabled: bool) -> bool:
    client = get_db()
    if not client:
        return False
    try:
        client.table("users").update({"deep_analysis_enabled": enabled}).eq("user_id", user_id).execute()
        return True
    except Exception as exc:
        logger.error("Failed to save deep_analysis for %s: %s", user_id, exc.__class__.__name__)
        return False


def _settings_payload(user_id: str, analysis: str, fast: str) -> SettingsResponse:
    tier = get_user_tier(user_id)
    bg_preset, bg_opacity = _get_user_background_prefs(user_id)
    user = get_user(user_id) or {}
    deep_enabled = bool(user.get("deep_analysis_enabled"))
    deep_allowed = tier == "researcher"
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    return SettingsResponse(
        has_anthropic_key=True,
        analysis_model=analysis,
        fast_model=fast,
        background_preset=bg_preset,
        background_opacity=bg_opacity,
        deep_analysis_enabled=deep_enabled if deep_allowed else False,
        deep_analysis_allowed=deep_allowed,
        deep_multiplier=DEEP_USAGE_MULTIPLIER,
        tier=tier,
        tier_limits=limits,
    )


@router.get("", response_model=SettingsResponse)
async def get_settings(user_id: str = Depends(require_auth)):
    analysis, fast = _get_user_model_prefs(user_id)
    enforced_analysis = enforce_model(user_id, analysis)
    enforced_fast = enforce_model(user_id, fast)
    return _settings_payload(user_id, enforced_analysis, enforced_fast)


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

    # Accept either the canonical ID or a known alias — this prevents a
    # stale client (tab left open before an app deploy that renamed a
    # model) from tripping a 403 on save. We canonicalize before
    # comparing against the tier's allow-list.
    requested_analysis = canonicalize_model(update.analysis_model)
    requested_fast = canonicalize_model(update.fast_model)

    if requested_analysis is not None and requested_analysis not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"Model '{update.analysis_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
        )

    if requested_fast is not None and requested_fast not in allowed:
        raise HTTPException(
            status_code=403,
            detail=f"Model '{update.fast_model}' is not available on your plan. Allowed: {', '.join(allowed)}",
        )

    ok = True
    if requested_analysis:
        normalized = enforce_model(user_id, requested_analysis)
        ok = _save_user_model_prefs(user_id, analysis_model=normalized) and ok
    if requested_fast:
        normalized = enforce_model(user_id, requested_fast)
        ok = _save_user_model_prefs(user_id, fast_model=normalized) and ok

    if update.background_preset is not None:
        preset = normalize_background_preset(update.background_preset) or "none"
        ok = _save_user_background_prefs(user_id, background_preset=preset) and ok
    if update.background_opacity is not None:
        opacity = clamp_background_opacity(update.background_opacity)
        if opacity is not None:
            ok = _save_user_background_prefs(user_id, background_opacity=opacity) and ok

    if update.deep_analysis_enabled is not None:
        tier = get_user_tier(user_id)
        if update.deep_analysis_enabled and tier != "researcher":
            raise HTTPException(
                status_code=403,
                detail={"code": "feature_locked", "message": "Deep analysis requires Researcher tier."},
            )
        ok = _save_user_deep_analysis(user_id, bool(update.deep_analysis_enabled)) and ok

    if not ok:
        raise HTTPException(
            status_code=500,
            detail="Could not save model preferences. Please try again later.",
        )

    analysis, fast = _get_user_model_prefs(user_id)
    return _settings_payload(user_id, analysis, fast)


@router.get("/models")
async def list_models(user_id: str = Depends(require_auth)):
    return {"models": get_allowed_models(user_id)}
