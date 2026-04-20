"""Feature gating based on user subscription tier."""

from __future__ import annotations

from fastapi import HTTPException

from .services.db import (
    get_user,
    get_usage_count,
    record_usage,
    get_daily_model_count,
)

ALL_MODELS = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4",
]

# Per-model daily caps (sub-budgets within `daily_api_calls`).
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
        "models": {"claude-haiku-4-5"},
        "best_model": "claude-haiku-4-5",
        "daily_api_calls": 10,
        "per_model_daily": {
            "claude-haiku-4-5": 10,
        },
    },
    "scholar": {
        "max_papers": 25,
        "qa_per_paper": 100,
        "selections_per_paper": 100,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection"},
        "models": {"claude-haiku-4-5", "claude-sonnet-4-6"},
        "best_model": "claude-sonnet-4-6",
        "daily_api_calls": 100,
        "per_model_daily": {
            "claude-haiku-4-5": 100,
            "claude-sonnet-4-6": 40,
        },
    },
    "researcher": {
        "max_papers": -1,
        "qa_per_paper": -1,
        "selections_per_paper": -1,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "multi-qa"},
        "models": {"claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4"},
        "best_model": "claude-opus-4",
        "daily_api_calls": 300,
        "per_model_daily": {
            "claude-haiku-4-5": 300,
            "claude-sonnet-4-6": 150,
            "claude-opus-4": 30,
        },
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
    if not check_and_increment_paper_count(user_id, max_papers):
        raise HTTPException(
            status_code=403,
            detail=f"Paper limit reached ({max_papers} papers on {tier} plan). Upgrade to add more.",
        )
    return tier


def check_usage_limit(
    user_id: str, paper_id: str, action: str, count: int = 1
) -> str:
    """Check per-paper usage limits (QA, selections). Returns the tier. Raises 403 on deny.

    ``count`` is the number of sub-operations the caller intends to perform
    (e.g. a batched Q&A answering 3 questions passes ``count=3``). The check
    rejects if ``current + count`` would exceed the paper's limit, so we fail
    fast before burning any LLM tokens.
    """
    if count < 1:
        count = 1
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])

    limit_key = {
        "qa": "qa_per_paper",
        "selection": "selections_per_paper",
    }.get(action)

    if not limit_key:
        return tier

    max_count = limits.get(limit_key, -1)
    if max_count == -1:
        return tier

    current = get_usage_count(user_id, paper_id, action)
    if current + count > max_count:
        remaining = max(0, max_count - current)
        raise HTTPException(
            status_code=403,
            detail=(
                f"Usage limit reached ({max_count} {action}s per paper on {tier} plan)."
                f" You have {remaining} left; tried to use {count}. Upgrade to continue."
            ),
        )
    return tier


def track_usage(
    user_id: str,
    paper_id: str,
    action: str,
    *,
    model: str | None = None,
    count: int = 1,
    record_daily: bool = True,
) -> int:
    """Record a usage event and enforce daily + per-paper + per-model limits.
    Returns the updated daily count.

    This is the single enforcement point for rate limits to avoid TOCTOU races:
    daily, per-model, and per-paper checks happen right before the atomic
    increment. When ``model`` is provided, the call also counts toward that
    model's daily sub-budget defined by ``TIER_LIMITS[tier]["per_model_daily"]``.

    ``count`` is the number of sub-operations in this one request (e.g.
    batched Q&A with N questions = N units). Limits are enforced against
    ``current + count`` so a batch that would push the user over the cap
    is rejected before any work is done.

    ``record_daily`` lets callers that fan out the same logical call across
    multiple papers (e.g. multi-paper Q&A) skip the daily / per-model bump
    on secondary rows so the account-wide counter isn't inflated.
    """
    if count < 1:
        count = 1
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])

    if record_daily:
        max_daily = limits.get("daily_api_calls", 20)
        if max_daily != -1:
            from .services.db import get_daily_api_count
            current = get_daily_api_count(user_id)
            if current + count > max_daily:
                raise HTTPException(
                    status_code=429,
                    detail=f"Daily API limit reached ({max_daily} calls/day on {tier} plan). Try again tomorrow or upgrade.",
                )

        if model:
            per_model = limits.get("per_model_daily") or {}
            if model in per_model:
                max_for_model = per_model[model]
                if max_for_model >= 0:
                    current_model = get_daily_model_count(user_id, model)
                    if current_model + count > max_for_model:
                        raise HTTPException(
                            status_code=429,
                            detail=(
                                f"Daily limit reached for {model} "
                                f"({max_for_model}/day on {tier} plan). "
                                "Pick a different model in Settings or try again tomorrow."
                            ),
                        )

    limit_key = {"qa": "qa_per_paper", "selection": "selections_per_paper"}.get(action)
    if limit_key:
        max_count = limits.get(limit_key, -1)
        if max_count != -1:
            current_paper = get_usage_count(user_id, paper_id, action)
            if current_paper + count > max_count:
                remaining = max(0, max_count - current_paper)
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"Usage limit reached ({max_count} {action}s per paper on {tier} plan)."
                        f" You have {remaining} left; tried to use {count}. Upgrade to continue."
                    ),
                )

    total = record_usage(
        user_id, paper_id, action, model=model, count=count, record_daily=record_daily
    )
    return total


def check_daily_api_limit(user_id: str) -> str:
    """Enforce daily API call limit across all actions. Returns tier. Raises 429 on deny."""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    max_daily = limits.get("daily_api_calls", 20)
    if max_daily == -1:
        return tier

    from .services.db import get_daily_api_count
    current = get_daily_api_count(user_id)
    if current >= max_daily:
        raise HTTPException(
            status_code=429,
            detail=f"Daily API limit reached ({max_daily} calls/day on {tier} plan). Try again tomorrow or upgrade.",
        )
    return tier


def get_allowed_models(user_id: str) -> list[str]:
    """Return the list of model IDs the user's tier allows."""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    allowed = limits["models"]
    return [m for m in ALL_MODELS if m in allowed]


def enforce_model(user_id: str, requested_model: str) -> str:
    """Return the model to actually use. Downgrades if tier doesn't allow it."""
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
    can know the model upfront (e.g. to pass it to ``track_usage``).
    """
    from .api.settings import _get_user_model_prefs
    analysis, _ = _get_user_model_prefs(user_id)
    return enforce_model(user_id, analysis)


def resolve_fast_model(user_id: str) -> str:
    """Return the fast model that will actually be used for ``user_id``."""
    from .api.settings import _get_user_model_prefs
    _, fast = _get_user_model_prefs(user_id)
    return enforce_model(user_id, fast)


def get_per_model_daily_usage(user_id: str) -> list[dict]:
    """Return today's per-model usage rows for the user, restricted to the
    models the current tier has any cap for. Each row is
    ``{"model": str, "used": int, "limit": int}``.
    """
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    per_model = limits.get("per_model_daily") or {}
    out: list[dict] = []
    for model in ALL_MODELS:
        if model not in per_model:
            continue
        cap = per_model[model]
        try:
            used = get_daily_model_count(user_id, model)
        except Exception:
            used = 0
        out.append({"model": model, "used": int(used or 0), "limit": int(cap)})
    return out
