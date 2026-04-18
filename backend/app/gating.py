"""Feature gating based on user subscription tier."""

from __future__ import annotations

from fastapi import HTTPException

from .services.db import get_user, get_usage_count, record_usage

ALL_MODELS = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4",
]

TIER_LIMITS: dict[str, dict] = {
    "free": {
        "max_papers": 3,
        "qa_per_paper": 5,
        "selections_per_paper": 3,
        "features": {"summary"},
        "models": {"claude-haiku-4-5"},
        "best_model": "claude-haiku-4-5",
        "daily_api_calls": 20,
    },
    "scholar": {
        "max_papers": 25,
        "qa_per_paper": 100,
        "selections_per_paper": 100,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection"},
        "models": {"claude-haiku-4-5", "claude-sonnet-4-6"},
        "best_model": "claude-sonnet-4-6",
        "daily_api_calls": 200,
    },
    "researcher": {
        "max_papers": -1,
        "qa_per_paper": -1,
        "selections_per_paper": -1,
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "multi-qa"},
        "models": {"claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4"},
        "best_model": "claude-opus-4",
        "daily_api_calls": 1000,
    },
}


def get_user_tier(user_id: str) -> str:
    user = get_user(user_id)
    return (user or {}).get("tier", "free")


def check_feature_access(user_id: str, feature: str) -> str:
    """Check if user can access a feature. Returns the tier. Raises 403/429 on deny."""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])

    if feature not in limits["features"]:
        raise HTTPException(
            status_code=403,
            detail=f"The '{feature}' feature requires a higher plan. Current plan: {tier}.",
        )

    max_daily = limits.get("daily_api_calls", 20)
    if max_daily != -1:
        from .services.db import get_daily_api_count
        current = get_daily_api_count(user_id)
        if current >= max_daily:
            raise HTTPException(
                status_code=429,
                detail=f"Daily API limit reached ({max_daily} calls/day on {tier} plan). Try again tomorrow or upgrade.",
            )

    return tier


def check_paper_limit(user_id: str) -> str:
    """Check if user can upload another paper. Returns the tier. Raises 403 on deny."""
    tier = get_user_tier(user_id)
    limits = TIER_LIMITS.get(tier, TIER_LIMITS["free"])
    max_papers = limits["max_papers"]

    if max_papers == -1:
        return tier

    user = get_user(user_id)
    current_count = (user or {}).get("paper_count", 0)
    if current_count >= max_papers:
        raise HTTPException(
            status_code=403,
            detail=f"Paper limit reached ({max_papers} papers on {tier} plan). Upgrade to add more.",
        )
    return tier


def check_usage_limit(user_id: str, paper_id: str, action: str) -> str:
    """Check per-paper usage limits (QA, selections). Returns the tier. Raises 403 on deny."""
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
    if current >= max_count:
        raise HTTPException(
            status_code=403,
            detail=f"Usage limit reached ({max_count} {action}s per paper on {tier} plan). Upgrade to continue.",
        )
    return tier


def track_usage(user_id: str, paper_id: str, action: str) -> int:
    """Record a usage event. Returns updated count."""
    return record_usage(user_id, paper_id, action)


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
