"""Feature gating and usage enforcement based on user subscription tier.

All rate limits flow through ``reserve_usage`` → atomic DB RPCs. That single
entry point fuses the check and the increment into one SQL statement so
concurrent requests can't race past a cap (see migration 008). Each route is
expected to:

    1. Call ``reserve_usage(...)`` BEFORE doing any expensive work.
       If the user is over a cap, an HTTP 403/429 is raised with a
       structured ``detail`` the frontend can dispatch on.
    2. Run the LLM / side effects.
    3. On failure, call ``release_usage(token)`` to compensate the reservation
       so users aren't debited for calls we never actually made.

The legacy ``check_usage_limit`` + post-LLM ``track_usage`` pattern is gone:
the two are now a single atomic call.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import HTTPException

logger = logging.getLogger(__name__)

from .services.db import (
    get_user,
    reserve_daily_api_usage,
    reserve_daily_capability_usage,
    reserve_daily_export_usage,
    release_daily_export_usage,
    reserve_paper_usage,
    release_daily_api_usage,
    release_daily_capability_usage,
    release_paper_usage,
    count_active_exports,
    _MAX_ACTIVE_EXPORTS,
)

ALL_MODELS = [
    # Anthropic (current Claude API IDs as of Aug 2026)
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "claude-fable-5",
    # OpenAI — 5.6 family: Luna/mini, Terra (balanced), Sol (flagship)
    "gpt-5.4-mini",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
    # Mistral (-latest tracks Small 4 / Medium 3.5 / Large 3)
    "mistral-small-latest",
    "mistral-medium-latest",
    "mistral-large-latest",
]

# Legacy/misnamed aliases that users may still have stored in their
# saved settings. We silently rewrite these on the fly so the first
# call after an app update doesn't 4xx against the provider. Extend this
# map when we retire another model ID.
MODEL_ALIASES = {
    # Anthropic — previous 4.x IDs still appear in saved Settings rows
    "claude-opus-4": "claude-fable-5",
    "claude-opus-4-0": "claude-fable-5",
    "claude-opus-4-1": "claude-fable-5",
    "claude-opus-4-5": "claude-fable-5",
    "claude-opus-4-6": "claude-fable-5",
    "claude-opus-4-7": "claude-fable-5",
    "claude-opus-4-8": "claude-fable-5",
    "claude-opus-5": "claude-fable-5",
    "claude-sonnet-4-0": "claude-sonnet-5",
    "claude-sonnet-4-5": "claude-sonnet-5",
    "claude-sonnet-4-6": "claude-sonnet-5",
    # OpenAI
    "gpt-4o": "gpt-5.4-mini",
    "gpt-4o-mini": "gpt-5.4-mini",
    "gpt-4.1": "gpt-5.6-terra",
    "gpt-4.1-mini": "gpt-5.4-mini",
    "gpt-4.1-nano": "gpt-5.4-mini",
    "gpt-5-mini": "gpt-5.4-mini",
    "gpt-5": "gpt-5.6-terra",
    "gpt-5.4": "gpt-5.6-sol",
    # Mistral
    "mistral-small": "mistral-small-latest",
    "mistral-medium": "mistral-medium-latest",
    "mistral-large": "mistral-large-latest",
    "mistral-tiny": "mistral-small-latest",
}


def canonicalize_model(model: str | None) -> str | None:
    """Normalize a possibly-stale model ID to a currently valid one.

    Users whose settings were saved under an older model alias would
    otherwise blow up on their next call because Anthropic rejects the
    string with a 4xx. This runs at every resolution path so we fix the
    user's choice at read time, and also heals stored rows next time
    they hit ``update_settings``.
    """
    if not model:
        return model
    return MODEL_ALIASES.get(model, model)


MODEL_TIER = {
    "claude-haiku-4-5": "fast",
    "gpt-5.4-mini": "fast",
    "gpt-5-mini": "fast",
    "mistral-small-latest": "fast",
    "claude-sonnet-5": "balanced",
    "gpt-5.6-terra": "balanced",
    "gpt-5": "balanced",
    "mistral-medium-latest": "balanced",
    "claude-fable-5": "top",
    "claude-opus-5": "top",
    "gpt-5.6-sol": "top",
    "gpt-5.4": "top",
    "mistral-large-latest": "top",
}

CAPABILITY_ORDER = ("fast", "balanced", "top")
CAPABILITY_LABEL = {
    "fast": "Fast",
    "balanced": "Balanced",
    "top": "Top",
}

# Shared capability daily caps (sub-budgets within `daily_api_calls`).
# These exist to prevent a single user from burning the whole daily budget on
# the most expensive model (e.g. picking Opus for everything on Researcher).
# A model not listed here is treated as "no extra cap" (i.e. only the overall
# `daily_api_calls` total applies). Set to 0 to disallow a model entirely.
TIER_LIMITS: dict[str, dict] = {
    "free": {
        "max_papers": 3,
        "qa_per_paper": 5,
        "selections_per_paper": 3,
        "features": {"summary", "qa", "selection"},
        "models": {
            "mistral-small-latest",
            "claude-haiku-4-5",
            "gpt-5.4-mini",
        },
        "best_model": "mistral-small-latest",
        "daily_api_calls": 10,
        "export_daily": {"pdf": 0, "pptx": 0, "podcast": 0},
        "per_capability_daily": {"fast": 10, "balanced": 0, "top": 0},
    },
    "scholar": {
        "max_papers": 25,
        "qa_per_paper": 100,
        "selections_per_paper": 100,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex", "export-pdf", "export-pptx"},
        "models": {
            "mistral-small-latest", "claude-haiku-4-5", "gpt-5.4-mini",
            "mistral-medium-latest", "claude-sonnet-5", "gpt-5.6-terra",
        },
        "best_model": "claude-sonnet-5",
        "daily_api_calls": 100,
        "export_daily": {"pdf": 5, "pptx": 3, "podcast": 0},
        "per_capability_daily": {"fast": 100, "balanced": 40, "top": 0},
    },
    "researcher": {
        "max_papers": -1,
        "qa_per_paper": -1,
        "selections_per_paper": -1,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex", "multi-qa", "export-pdf", "export-pptx"},
        "models": {
            "mistral-small-latest", "claude-haiku-4-5", "gpt-5.4-mini",
            "mistral-medium-latest", "claude-sonnet-5", "gpt-5.6-terra",
            "mistral-large-latest", "claude-fable-5", "gpt-5.6-sol",
        },
        "best_model": "claude-fable-5",
        "daily_api_calls": 300,
        "export_daily": {"pdf": 20, "pptx": 10, "podcast": 0},
        "per_capability_daily": {"fast": 300, "balanced": 150, "top": 30},
    },
}


def get_user_tier(user_id: str) -> str:
    user = get_user(user_id)
    if not user:
        return "free"
    tier = user.get("tier", "free")
    if tier not in TIER_LIMITS:
        return "free"
    return tier


def check_feature_access(user_id: str, feature: str) -> str:
    """Check if user can access a feature. Returns the tier. Raises 403 on deny."""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])

    if feature not in limits["features"]:
        raise HTTPException(
            status_code=403,
            detail=f"The '{feature}' feature requires a higher plan. Current plan: {tier}.",
        )

    return tier


def check_paper_limit(user_id: str) -> str:
    """Check if user can upload another paper and atomically reserve the slot.
    Returns the tier. Raises 403/503 on deny.
    """
    user = get_user(user_id)
    if not user:
        raise HTTPException(status_code=503, detail="Database unavailable — cannot verify paper limit.")
    tier = user.get("tier", "free")
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    max_papers = limits["max_papers"]

    if max_papers == -1:
        from .services.db import increment_paper_count
        increment_paper_count(user_id, 1)
        return tier

    from .services.db import check_and_increment_paper_count
    slot = check_and_increment_paper_count(user_id, max_papers)
    if slot is None:
        raise HTTPException(
            status_code=503,
            detail="Database unavailable — cannot verify paper limit.",
        )
    if not slot:
        raise HTTPException(
            status_code=403,
            detail=f"Paper limit reached ({max_papers} papers on {tier} plan). Upgrade to add more.",
        )
    return tier


# ---------------------------------------------------------------------------
# Usage reservation (replaces check_usage_limit + track_usage)
# ---------------------------------------------------------------------------

PER_PAPER_LIMIT_KEYS = {
    "qa": "qa_per_paper",
    "selection": "selections_per_paper",
}


def _today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def reserve_usage(
    user_id: str,
    paper_id: str,
    action: str,
    *,
    model: str | None = None,
    count: int = 1,
    record_daily: bool = True,
) -> dict:
    """Atomically check-and-reserve all caps that apply to this call.

    Raises:
        HTTPException(429) with a structured ``detail`` dict when the daily
            total or per-model sub-budget is exhausted.
        HTTPException(403) when the per-paper cap for ``action`` is reached,
            or when the feature itself is denied. (The feature check itself
            should happen at the top of each route via
            ``check_feature_access``.)
        HTTPException(503) if the database is unreachable — we fail closed
            because we can't enforce caps without it, and silently allowing
            the call would let a malicious client burn through quotas.

    Returns:
        A token dict that MUST be passed to ``release_usage`` if the
        downstream work (LLM call, streaming, etc.) fails, so the
        reservation is rolled back instead of leaving the user debited for
        a call that produced nothing.

    Parameters:
        count: number of sub-operations in this one logical call (e.g. a
            batched Q&A request with N questions passes ``count=N``).
        record_daily: set to False for secondary rows in multi-paper
            fan-outs (/multi-qa) so the account-wide daily total and the
            per-model daily sub-budget aren't inflated by every paper in
            the session.
    """
    if count < 1:
        count = 1

    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    today = _today_iso()
    capability: str | None = None

    if model:
        model = canonicalize_model(model) or model

    # Track which buckets we successfully debited so we can roll back exactly
    # what we charged if a later reservation fails.
    reserved = {"daily": False, "capability": False, "paper": False}

    try:
        if model:
            allowed_models = limits.get("models") or set()
            if model not in allowed_models:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "model_tier_locked",
                        "model": model,
                        "tier": tier,
                        "message": (
                            f"{model} is not available on the {tier} plan. "
                            "Upgrade to unlock this model."
                        ),
                    },
                )
            capability = MODEL_TIER.get(model)
            if capability:
                per_capability = limits.get("per_capability_daily") or {}
                max_for_capability = int(per_capability.get(capability, 0))
                if max_for_capability == 0:
                    raise HTTPException(
                        status_code=403,
                        detail={
                            "code": "model_tier_locked",
                            "model": model,
                            "capability": capability,
                            "tier": tier,
                            "message": (
                                f"{CAPABILITY_LABEL.get(capability, capability)} models "
                                f"are not available on the {tier} plan. Upgrade to continue."
                            ),
                        },
                    )

        if record_daily:
            max_daily = int(limits.get("daily_api_calls", 20))
            res = reserve_daily_api_usage(user_id, today, count, max_daily)
            if res == -1:
                raise HTTPException(
                    status_code=429,
                    detail={
                        "code": "daily_cap",
                        "limit": max_daily,
                        "tier": tier,
                        "message": (
                            f"Daily API limit reached ({max_daily} calls/day on "
                            f"{tier} plan). Try again tomorrow or upgrade."
                        ),
                    },
                )
            reserved["daily"] = True

            if model and capability:
                per_capability = limits.get("per_capability_daily") or {}
                max_for_capability = int(per_capability.get(capability, 0))
                res2 = reserve_daily_capability_usage(
                    user_id, today, capability, count, max_for_capability
                )
                if res2 == -1:
                    raise HTTPException(
                        status_code=429,
                        detail={
                            "code": "capability_cap",
                            "capability": capability,
                            "model": model,
                            "limit": max_for_capability,
                            "tier": tier,
                            "message": (
                                f"Daily limit reached for "
                                f"{CAPABILITY_LABEL.get(capability, capability).lower()} "
                                f"models ({max_for_capability}/day on {tier} plan). "
                                "Pick a different model in Settings or try again tomorrow."
                            ),
                        },
                    )
                reserved["capability"] = True

        limit_key = PER_PAPER_LIMIT_KEYS.get(action)
        max_paper = int(limits.get(limit_key, -1)) if limit_key else -1

        res3 = reserve_paper_usage(
            user_id, paper_id, action, today, count, max_paper
        )
        if res3 == -1:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "paper_cap",
                    "action": action,
                    "limit": max_paper,
                    "tier": tier,
                    "message": (
                        f"Usage limit reached ({max_paper} {action}s per paper on "
                        f"{tier} plan). Upgrade to continue."
                    ),
                },
            )
        reserved["paper"] = True
    except HTTPException:
        try:
            if reserved["capability"] and capability:
                release_daily_capability_usage(user_id, today, capability, count)
            if reserved["daily"]:
                release_daily_api_usage(user_id, today, count)
            if reserved["paper"]:
                release_paper_usage(user_id, paper_id, action, today, count)
        except Exception:
            logger.exception(
                "reserve_usage rollback failed (user=%s paper=%s action=%s model=%s)",
                user_id, paper_id, action, model,
            )
        raise
    except Exception:
        # Any unexpected error path (DB connectivity etc.): roll back what we
        # reserved and surface as 503 so the client doesn't get charged for
        # a broken reservation.
        logger.exception(
            "reserve_usage 503 (user=%s paper=%s action=%s model=%s tier=%s "
            "reserved=%s) — check that migrations 005/006/008/023 have been applied "
            "and that Supabase is reachable",
            user_id, paper_id, action, model, tier, reserved,
        )
        if reserved["capability"] and capability:
            release_daily_capability_usage(user_id, today, capability, count)
        if reserved["daily"]:
            release_daily_api_usage(user_id, today, count)
        if reserved["paper"]:
            release_paper_usage(user_id, paper_id, action, today, count)
        raise HTTPException(
            status_code=503,
            detail="Usage tracking unavailable — please try again.",
        )

    return {
        "user_id": user_id,
        "paper_id": paper_id,
        "action": action,
        "model": model,
        "capability": capability,
        "count": count,
        "record_daily": record_daily,
        "today": today,
    }


def release_usage(token: dict | None) -> None:
    """Best-effort rollback of a prior ``reserve_usage`` call.

    Pass the token returned by ``reserve_usage`` when the downstream work
    fails (LLM exception, streaming client disconnect, etc.). Releases clamp
    at zero in SQL so even duplicate releases are safe. This is intentionally
    best-effort: compensation errors MUST NOT mask the original failure.
    """
    if not token:
        return
    count = int(token.get("count") or 1)
    if count <= 0:
        return
    today = token.get("today") or _today_iso()
    user_id = token.get("user_id") or ""
    paper_id = token.get("paper_id") or ""
    action = token.get("action") or ""
    model = token.get("model")
    capability = token.get("capability")
    record_daily = bool(token.get("record_daily", True))
    if not user_id:
        return
    try:
        release_paper_usage(user_id, paper_id, action, today, count)
    except Exception:
        pass
    if record_daily:
        if capability:
            try:
                release_daily_capability_usage(user_id, today, capability, count)
            except Exception:
                pass
        try:
            release_daily_api_usage(user_id, today, count)
        except Exception:
            pass


def get_allowed_models(user_id: str) -> list[str]:
    """Return the list of model IDs the user's tier allows."""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    allowed = limits["models"]
    return [m for m in ALL_MODELS if m in allowed]


def enforce_model(user_id: str, requested_model: str) -> str:
    """Return the model to actually use. Downgrades if tier doesn't allow it.

    We canonicalize first so that settings rows holding a stale alias
    (e.g. ``claude-opus-4-7`` after Anthropic moved the flagship to
    ``claude-fable-5``) resolve to the current ID instead of falling
    all the way through to the tier default.
    """
    requested_model = canonicalize_model(requested_model) or ""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    if requested_model in limits["models"]:
        return requested_model
    return limits["best_model"]


def get_tier_best_model(tier: str) -> str:
    """Return the best model a tier has access to."""
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    return limits["best_model"]


def resolve_analysis_model(user_id: str) -> str:
    """Return the analysis model that will actually be used for ``user_id``.

    Mirrors the resolution that happens inside ``llm.get_provider`` so callers
    can know the model upfront (e.g. to pass it to ``reserve_usage``).
    """
    from .api.settings import _get_user_model_prefs
    analysis, _ = _get_user_model_prefs(user_id)
    return enforce_model(user_id, analysis)


def get_capability_daily_usage(user_id: str) -> list[dict]:
    """Return today's shared capability usage rows for the user."""
    from .services.db import get_daily_capability_counts

    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    per_capability = limits.get("per_capability_daily") or {}
    counts = get_daily_capability_counts(user_id)
    out: list[dict] = []
    for capability in CAPABILITY_ORDER:
        if capability not in per_capability:
            continue
        cap = int(per_capability[capability])
        out.append({
            "capability": capability,
            "label": CAPABILITY_LABEL[capability],
            "used": int(counts.get(capability) or 0),
            "limit": cap,
        })
    return out


def get_per_model_daily_usage(user_id: str) -> list[dict]:
    """Deprecated display helper — per-model caps replaced by capability buckets."""
    return []


_EXPORT_FEATURE_MAP = {"pdf": "export-pdf", "pptx": "export-pptx", "podcast": "export-podcast"}


def reserve_export_usage(user_id: str, fmt: str) -> dict:
    """Atomically check tier access and reserve one daily export slot."""
    feature = _EXPORT_FEATURE_MAP.get(fmt)
    if not feature:
        raise HTTPException(status_code=400, detail=f"Unknown export format: {fmt}")

    tier = check_feature_access(user_id, feature)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    export_daily = limits.get("export_daily") or {}
    max_for_fmt = int(export_daily.get(fmt, 0))
    if max_for_fmt <= 0:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "export_tier",
                "format": fmt,
                "tier": tier,
                "message": f"Export to {fmt.upper()} requires a higher plan.",
            },
        )

    active = count_active_exports(user_id)
    if active >= _MAX_ACTIVE_EXPORTS:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "export_concurrent",
                "limit": _MAX_ACTIVE_EXPORTS,
                "message": "Too many exports in progress. Wait for one to finish.",
            },
        )

    today = _today_iso()
    res = reserve_daily_export_usage(user_id, today, fmt, 1, max_for_fmt)
    if res == -1:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "daily_export_cap",
                "format": fmt,
                "limit": max_for_fmt,
                "tier": tier,
                "message": (
                    f"Daily {fmt.upper()} export limit reached "
                    f"({max_for_fmt}/day on {tier} plan)."
                ),
            },
        )

    return {"user_id": user_id, "format": fmt, "today": today, "count": 1}


def release_export_usage(token: dict | None) -> None:
    if not token:
        return
    user_id = token.get("user_id") or ""
    fmt = token.get("format") or ""
    today = token.get("today") or _today_iso()
    count = int(token.get("count") or 1)
    if not user_id or not fmt:
        return
    try:
        release_daily_export_usage(user_id, today, fmt, count)
    except Exception:
        pass


def resolve_deep_analysis(user_id: str) -> bool:
    """Researcher-only opt-in for expanded prompt budgets."""
    user = get_user(user_id)
    if not user:
        return False
    if (user.get("tier") or "free") != "researcher":
        return False
    return bool(user.get("deep_analysis_enabled"))


DEEP_USAGE_MULTIPLIER = 2


def get_usage_multiplier(user_id: str | None) -> int:
    """How many quota units a single call consumes (2 when deep analysis is on).

    Export jobs do NOT use this multiplier — they have separate per-format
    daily caps via ``reserve_export_usage``.
    """
    if user_id and resolve_deep_analysis(user_id):
        return DEEP_USAGE_MULTIPLIER
    return 1


def resolve_fast_model(user_id: str) -> str:
    """Return the fast model that will actually be used for ``user_id``."""
    from .api.settings import _get_user_model_prefs
    _, fast = _get_user_model_prefs(user_id)
    return enforce_model(user_id, fast)
