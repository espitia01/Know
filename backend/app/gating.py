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

from datetime import datetime, timezone

from fastapi import HTTPException

from .services.db import (
    get_user,
    get_daily_model_count,
    reserve_daily_api_usage,
    reserve_daily_model_usage,
    reserve_paper_usage,
    release_daily_api_usage,
    release_daily_model_usage,
    release_paper_usage,
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
        # NOTE: "bibtex" intentionally missing — free can't export.
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
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex"},
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
        "features": {"summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex", "multi-qa"},
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

    # Track which buckets we successfully debited so we can roll back exactly
    # what we charged if a later reservation fails.
    reserved = {"daily": False, "model": False, "paper": False}

    try:
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

            if model:
                per_model = limits.get("per_model_daily") or {}
                if model in per_model:
                    max_for_model = int(per_model[model])
                    res2 = reserve_daily_model_usage(
                        user_id, today, model, count, max_for_model
                    )
                    if res2 == -1:
                        raise HTTPException(
                            status_code=429,
                            detail={
                                "code": "model_cap",
                                "model": model,
                                "limit": max_for_model,
                                "tier": tier,
                                "message": (
                                    f"Daily limit reached for {model} "
                                    f"({max_for_model}/day on {tier} plan). "
                                    "Pick a different model in Settings or try again tomorrow."
                                ),
                            },
                        )
                    reserved["model"] = True

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
        if reserved["model"] and model:
            release_daily_model_usage(user_id, today, model, count)
        if reserved["daily"]:
            release_daily_api_usage(user_id, today, count)
        if reserved["paper"]:
            release_paper_usage(user_id, paper_id, action, today, count)
        raise
    except Exception:
        # Any unexpected error path (DB connectivity etc.): roll back what we
        # reserved and surface as 503 so the client doesn't get charged for
        # a broken reservation.
        if reserved["model"] and model:
            release_daily_model_usage(user_id, today, model, count)
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
    record_daily = bool(token.get("record_daily", True))
    if not user_id:
        return
    try:
        release_paper_usage(user_id, paper_id, action, today, count)
    except Exception:
        pass
    if record_daily:
        if model:
            try:
                release_daily_model_usage(user_id, today, model, count)
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
    can know the model upfront (e.g. to pass it to ``reserve_usage``).
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
            # Display-only path: fall back to 0 to avoid surfacing a DB blip
            # as a user-visible error. Enforcement still fails closed via
            # `reserve_usage` above.
            used = 0
        out.append({"model": model, "used": int(used or 0), "limit": int(cap)})
    return out
