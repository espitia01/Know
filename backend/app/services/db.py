"""Supabase client wrapper for the Know backend."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from ..config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_client():
    from supabase import create_client

    if not settings.supabase_url or not settings.supabase_key:
        return None
    return create_client(settings.supabase_url, settings.supabase_key)


def get_db():
    """Return the Supabase client (or None when not configured)."""
    return _get_client()


def _safe_single(query) -> dict | None:
    """Execute a query expecting 0 or 1 rows. Returns the row dict or None."""
    try:
        res = query.maybe_single().execute()
        if res and res.data:
            return res.data
    except Exception as e:
        logger.debug("_safe_single maybe_single fallback: %s", e)
    try:
        res = query.execute()
        if res and res.data:
            rows = res.data
            return rows[0] if isinstance(rows, list) and rows else None
    except Exception as e:
        logger.warning("_safe_single query failed: %s", e)
    return None


# ----------------------------------------------------------------
# User helpers
# ----------------------------------------------------------------

def get_or_create_user(user_id: str, email: str = "") -> dict:
    client = get_db()
    if not client:
        return {"user_id": user_id, "tier": "free", "paper_count": 0}

    existing = _safe_single(client.table("users").select("*").eq("user_id", user_id))
    if existing:
        return existing

    row = {"user_id": user_id, "email": email, "tier": "free", "paper_count": 0}
    try:
        client.table("users").insert(row).execute()
    except Exception:
        existing = _safe_single(client.table("users").select("*").eq("user_id", user_id))
        if existing:
            return existing
    return row


def get_user(user_id: str) -> dict | None:
    client = get_db()
    if not client:
        return {"user_id": user_id, "tier": "free", "paper_count": 0}
    return _safe_single(client.table("users").select("*").eq("user_id", user_id))


def update_user_tier(user_id: str, tier: str) -> None:
    client = get_db()
    if not client:
        return
    client.table("users").update({"tier": tier}).eq("user_id", user_id).execute()


def update_user_stripe_customer(user_id: str, customer_id: str) -> None:
    client = get_db()
    if not client:
        return
    client.table("users").update({"stripe_customer_id": customer_id}).eq("user_id", user_id).execute()


def get_user_by_stripe_customer(customer_id: str) -> dict | None:
    client = get_db()
    if not client:
        return None
    return _safe_single(client.table("users").select("*").eq("stripe_customer_id", customer_id))


def increment_paper_count(user_id: str, delta: int = 1) -> None:
    client = get_db()
    if not client:
        return
    try:
        client.rpc("increment_paper_count", {"uid": user_id, "delta": delta}).execute()
    except Exception:
        user = get_user(user_id)
        if user:
            new_count = max(0, (user.get("paper_count") or 0) + delta)
            client.table("users").update({"paper_count": new_count}).eq("user_id", user_id).execute()


# ----------------------------------------------------------------
# Paper CRUD
# ----------------------------------------------------------------

def save_paper_meta(paper_dict: dict, user_id: str) -> None:
    """Upsert paper metadata into Supabase."""
    client = get_db()
    if not client:
        return

    row = {
        "id": paper_dict["id"],
        "user_id": user_id,
        "title": paper_dict.get("title", ""),
        "authors": paper_dict.get("authors", []),
        "folder": paper_dict.get("folder", ""),
        "tags": paper_dict.get("tags", []),
        "notes": paper_dict.get("notes", []),
        "cached_analysis": paper_dict.get("cached_analysis", {}),
    }
    client.table("papers").upsert(row, on_conflict="id").execute()


def get_paper_meta(paper_id: str, user_id: str | None = None) -> dict | None:
    client = get_db()
    if not client:
        return None

    q = client.table("papers").select("*").eq("id", paper_id)
    if user_id:
        q = q.eq("user_id", user_id)
    return _safe_single(q)


def get_cached_analysis(paper_id: str, user_id: str) -> dict:
    """Return cached_analysis from Supabase for a given paper, or empty dict."""
    client = get_db()
    if not client:
        return {}
    row = _safe_single(
        client.table("papers")
        .select("cached_analysis")
        .eq("id", paper_id)
        .eq("user_id", user_id)
    )
    if row and isinstance(row.get("cached_analysis"), dict):
        return row["cached_analysis"]
    return {}


def update_cached_analysis(paper_id: str, user_id: str, cached_analysis: dict) -> None:
    """Update only the cached_analysis column in Supabase."""
    client = get_db()
    if not client:
        return
    try:
        client.table("papers").update(
            {"cached_analysis": cached_analysis}
        ).eq("id", paper_id).eq("user_id", user_id).execute()
    except Exception as e:
        logger.error("Failed to update cached_analysis: %s", e)


def list_papers_meta(user_id: str) -> list[dict]:
    client = get_db()
    if not client:
        return []

    try:
        res = (
            client.table("papers")
            .select("id, title, folder, tags, authors, notes, created_at")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .execute()
        )
        rows = res.data or [] if res else []
    except Exception:
        return []

    for r in rows:
        notes = r.get("notes") or []
        r["notes_count"] = len(notes) if isinstance(notes, list) else 0
    return rows


def delete_paper_meta(paper_id: str, user_id: str) -> None:
    client = get_db()
    if not client:
        return
    client.table("papers").delete().eq("id", paper_id).eq("user_id", user_id).execute()


# ----------------------------------------------------------------
# Usage tracking (for free-tier rate limits)
# ----------------------------------------------------------------

def record_usage(user_id: str, paper_id: str, action: str) -> int:
    """Atomically record a usage event and return today's total for this action+paper."""
    client = get_db()
    if not client:
        return 0

    from datetime import timezone, datetime

    today = datetime.now(timezone.utc).date().isoformat()

    try:
        res = client.rpc("increment_usage", {
            "p_user_id": user_id,
            "p_paper_id": paper_id,
            "p_action": action,
            "p_date": today,
        }).execute()
        if res and res.data is not None:
            return int(res.data)
    except Exception as e:
        logger.warning("increment_usage RPC failed, using fallback: %s", e)

    existing = _safe_single(
        client.table("usage")
        .select("id, count")
        .eq("user_id", user_id)
        .eq("paper_id", paper_id)
        .eq("action", action)
        .eq("date", today)
    )

    if existing:
        new_count = (existing.get("count") or 0) + 1
        client.table("usage").update({"count": new_count}).eq("id", existing["id"]).execute()
        return new_count
    else:
        try:
            client.table("usage").insert({
                "user_id": user_id,
                "paper_id": paper_id,
                "action": action,
                "count": 1,
                "date": today,
            }).execute()
        except Exception as e:
            logger.warning("Usage insert failed: %s", e)
        return 1


def store_cancellation_feedback(user_id: str, reason: str, feedback: str) -> None:
    """Persist cancel reason + free-text feedback to the feedback table."""
    client = get_db()
    if not client:
        return
    try:
        client.table("feedback").insert({
            "user_id": user_id,
            "type": "cancellation",
            "reason": reason,
            "message": feedback,
        }).execute()
    except Exception as e:
        logger.error("Failed to store cancellation feedback: %s", e)


def store_feedback(user_id: str | None, message: str) -> None:
    """Persist general product feedback."""
    client = get_db()
    if not client:
        return
    try:
        client.table("feedback").insert({
            "user_id": user_id or "anonymous",
            "type": "general",
            "reason": "",
            "message": message,
        }).execute()
    except Exception as e:
        logger.error("Failed to store feedback: %s", e)


def get_usage_count(user_id: str, paper_id: str, action: str) -> int:
    """Get today's usage count for a given action on a paper."""
    client = get_db()
    if not client:
        return 0

    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).date().isoformat()
    existing = _safe_single(
        client.table("usage")
        .select("count")
        .eq("user_id", user_id)
        .eq("paper_id", paper_id)
        .eq("action", action)
        .eq("date", today)
    )
    return (existing or {}).get("count", 0)


def get_daily_api_count(user_id: str) -> int:
    """Get total API calls across all actions for today."""
    client = get_db()
    if not client:
        return 0

    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).date().isoformat()
    try:
        res = (
            client.table("usage")
            .select("count")
            .eq("user_id", user_id)
            .eq("date", today)
            .execute()
        )
        rows = res.data or [] if res else []
        return sum(r.get("count", 0) for r in rows)
    except Exception as e:
        logger.warning("get_daily_api_count failed: %s", e)
        return 0


# ----------------------------------------------------------------
# Workspace helpers
# ----------------------------------------------------------------

def save_workspace(user_id: str, workspace_id: str | None, name: str,
                   paper_ids: list[str], cross_paper_results: list[dict]) -> dict | None:
    """Upsert a workspace. Returns the saved row."""
    client = get_db()
    if not client:
        return None

    from datetime import datetime, timezone
    import uuid

    if workspace_id:
        existing = _safe_single(
            client.table("workspaces").select("user_id").eq("id", workspace_id)
        )
        if existing and existing.get("user_id") != user_id:
            return None

    ws_id = workspace_id or str(uuid.uuid4())

    row: dict = {
        "id": ws_id,
        "user_id": user_id,
        "name": name,
        "paper_ids": paper_ids,
        "cross_paper_results": cross_paper_results,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        res = client.table("workspaces").upsert(row, on_conflict="id").execute()
        if res and res.data:
            return res.data[0] if isinstance(res.data, list) else res.data
    except Exception as e:
        logger.error("Failed to save workspace: %s", e)

    return row


def list_workspaces(user_id: str) -> list[dict]:
    """List all workspaces for a user, newest first."""
    client = get_db()
    if not client:
        return []
    try:
        res = (
            client.table("workspaces")
            .select("id, name, paper_ids, cross_paper_results, updated_at, created_at")
            .eq("user_id", user_id)
            .order("updated_at", desc=True)
            .execute()
        )
        return res.data or [] if res else []
    except Exception as e:
        logger.error("Failed to list workspaces: %s", e)
        return []


def get_workspace(workspace_id: str, user_id: str) -> dict | None:
    """Get a single workspace by ID, scoped to user."""
    client = get_db()
    if not client:
        return None
    return _safe_single(
        client.table("workspaces")
        .select("*")
        .eq("id", workspace_id)
        .eq("user_id", user_id)
    )


def delete_workspace(workspace_id: str, user_id: str) -> None:
    """Delete a workspace."""
    client = get_db()
    if not client:
        return
    try:
        client.table("workspaces").delete().eq("id", workspace_id).eq("user_id", user_id).execute()
    except Exception as e:
        logger.error("Failed to delete workspace: %s", e)
