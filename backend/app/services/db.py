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
        return None
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
    except Exception as e:
        logger.warning("increment_paper_count RPC failed, retrying once: %s", e)
        try:
            client.rpc("increment_paper_count", {"uid": user_id, "delta": delta}).execute()
        except Exception:
            logger.error("increment_paper_count retry also failed for user %s", user_id)


def check_and_increment_paper_count(user_id: str, max_papers: int) -> bool:
    """Atomically check the paper limit and increment if under. Returns True on success.
    
    Uses the DB-level RPC when available; falls back to read-then-write with a recheck
    to minimize the race window.
    """
    client = get_db()
    if not client:
        return False

    try:
        res = client.rpc("check_and_increment_paper_count", {
            "uid": user_id, "max_count": max_papers
        }).execute()
        if res and res.data is not None:
            return bool(res.data)
    except Exception as e:
        logger.debug("check_and_increment_paper_count RPC unavailable: %s", e)

    user = get_user(user_id)
    if not user:
        return False
    current = user.get("paper_count", 0)
    if current >= max_papers:
        return False
    increment_paper_count(user_id, 1)
    return True


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
        "raw_text": paper_dict.get("raw_text", ""),
    }
    try:
        client.table("papers").upsert(row, on_conflict="id").execute()
    except Exception:
        row.pop("raw_text", None)
        try:
            client.table("papers").upsert(row, on_conflict="id").execute()
        except Exception as e:
            logger.error("save_paper_meta failed: %s", e)


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

_daily_api_bootstrap_done = False


def _ensure_daily_api_usage_table(client) -> None:
    """Lazily create daily_api_usage table + RPC if they don't exist.

    We can't rely on hand-run migrations being applied against every Supabase
    project, so the backend self-heals the schema the first time it touches
    the table. Safe to call many times.
    """
    global _daily_api_bootstrap_done
    if _daily_api_bootstrap_done:
        return
    try:
        client.table("daily_api_usage").select("user_id").limit(1).execute()
        _daily_api_bootstrap_done = True
        return
    except Exception:
        pass

    sql = """
    CREATE TABLE IF NOT EXISTS daily_api_usage (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        date    DATE NOT NULL,
        count   INT  NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, date)
    );
    CREATE OR REPLACE FUNCTION increment_daily_api_usage(p_user_id text, p_date date)
    RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE new_count integer;
    BEGIN
        INSERT INTO daily_api_usage (user_id, date, count)
        VALUES (p_user_id, p_date, 1)
        ON CONFLICT (user_id, date)
        DO UPDATE SET count = daily_api_usage.count + 1
        RETURNING count INTO new_count;
        RETURN new_count;
    END;
    $$;
    """
    try:
        client.rpc("exec_sql", {"query": sql}).execute()
    except Exception as e:
        logger.warning("daily_api_usage auto-create skipped: %s", e)
    _daily_api_bootstrap_done = True


_daily_model_bootstrap_done = False


def _ensure_daily_model_usage_table(client) -> None:
    """Lazily create daily_model_usage table + RPC if missing.

    Mirrors `_ensure_daily_api_usage_table` so deploys that haven't applied
    migration 006 still get correct per-model accounting.
    """
    global _daily_model_bootstrap_done
    if _daily_model_bootstrap_done:
        return
    try:
        client.table("daily_model_usage").select("user_id").limit(1).execute()
        _daily_model_bootstrap_done = True
        return
    except Exception:
        pass

    sql = """
    CREATE TABLE IF NOT EXISTS daily_model_usage (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        date    DATE NOT NULL,
        model   TEXT NOT NULL,
        count   INT  NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, date, model)
    );
    CREATE OR REPLACE FUNCTION increment_daily_model_usage(
        p_user_id text, p_date date, p_model text
    ) RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE new_count integer;
    BEGIN
        INSERT INTO daily_model_usage (user_id, date, model, count)
        VALUES (p_user_id, p_date, p_model, 1)
        ON CONFLICT (user_id, date, model)
        DO UPDATE SET count = daily_model_usage.count + 1
        RETURNING count INTO new_count;
        RETURN new_count;
    END;
    $$;
    """
    try:
        client.rpc("exec_sql", {"query": sql}).execute()
    except Exception as e:
        logger.warning("daily_model_usage auto-create skipped: %s", e)
    _daily_model_bootstrap_done = True


def _record_daily_model_call(client, user_id: str, today_str: str, model: str) -> None:
    """Increment today's per-model API count for the user. Best-effort."""
    if not model:
        return
    _ensure_daily_model_usage_table(client)
    try:
        client.rpc("increment_daily_model_usage", {
            "p_user_id": user_id,
            "p_date": today_str,
            "p_model": model,
        }).execute()
        return
    except Exception as e:
        logger.debug("increment_daily_model_usage RPC failed, falling back: %s", e)

    try:
        existing = _safe_single(
            client.table("daily_model_usage")
            .select("count")
            .eq("user_id", user_id)
            .eq("date", today_str)
            .eq("model", model)
        )
        if existing is not None:
            new_count = (existing.get("count") or 0) + 1
            client.table("daily_model_usage").update({"count": new_count}) \
                .eq("user_id", user_id).eq("date", today_str).eq("model", model).execute()
        else:
            client.table("daily_model_usage").insert({
                "user_id": user_id,
                "date": today_str,
                "model": model,
                "count": 1,
            }).execute()
    except Exception as e:
        logger.error("daily_model_usage write failed for user %s/%s: %s", user_id, model, e)


def get_daily_model_count(user_id: str, model: str) -> int:
    """Return today's API-call count for a specific model. Returns 0 when DB is
    unavailable or the table hasn't been provisioned yet."""
    if not model:
        return 0
    client = get_db()
    if not client:
        return 0

    from datetime import datetime, timezone
    today_str = datetime.now(timezone.utc).date().isoformat()

    try:
        _ensure_daily_model_usage_table(client)
        row = _safe_single(
            client.table("daily_model_usage")
            .select("count")
            .eq("user_id", user_id)
            .eq("date", today_str)
            .eq("model", model)
        )
        if row is not None:
            return int(row.get("count") or 0)
    except Exception as e:
        logger.debug("daily_model_usage read failed: %s", e)
    return 0


def _record_daily_api_call(client, user_id: str, today_str: str) -> None:
    """Increment today's account-wide API-call count for the user.

    Writes to `daily_api_usage`, a user-scoped table that is NOT cascaded from
    `papers`. This keeps the daily counter stable across paper deletions and
    trial cleanups.
    """
    _ensure_daily_api_usage_table(client)
    try:
        client.rpc("increment_daily_api_usage", {
            "p_user_id": user_id,
            "p_date": today_str,
        }).execute()
        return
    except Exception as e:
        logger.debug("increment_daily_api_usage RPC failed, falling back to table ops: %s", e)

    try:
        existing = _safe_single(
            client.table("daily_api_usage")
            .select("count")
            .eq("user_id", user_id)
            .eq("date", today_str)
        )
        if existing is not None:
            new_count = (existing.get("count") or 0) + 1
            client.table("daily_api_usage").update({"count": new_count}) \
                .eq("user_id", user_id).eq("date", today_str).execute()
        else:
            client.table("daily_api_usage").insert({
                "user_id": user_id,
                "date": today_str,
                "count": 1,
            }).execute()
    except Exception as e:
        logger.error("daily_api_usage write failed for user %s: %s", user_id, e)


def record_usage(user_id: str, paper_id: str, action: str, *, model: str | None = None) -> int:
    """Record a usage event and return today's total for this action+paper.

    When ``model`` is provided, the call is also counted toward that model's
    daily total in `daily_model_usage`, which powers per-model rate limits.
    """
    client = get_db()
    if not client:
        return 0

    from datetime import timezone, datetime

    today_str = datetime.now(timezone.utc).date().isoformat()

    # Always increment the account-level daily counter in the paper-independent
    # table, so it survives paper deletions / CASCADE cleanup.
    _record_daily_api_call(client, user_id, today_str)
    if model:
        _record_daily_model_call(client, user_id, today_str, model)

    existing = _safe_single(
        client.table("usage")
        .select("id, count")
        .eq("user_id", user_id)
        .eq("paper_id", paper_id)
        .eq("action", action)
        .gte("date", today_str)
        .lte("date", today_str)
    )

    if existing:
        new_count = (existing.get("count") or 0) + 1
        try:
            client.table("usage").update({"count": new_count}).eq("id", existing["id"]).execute()
        except Exception as e:
            logger.warning("Usage update failed: %s", e)
        return new_count
    else:
        try:
            client.table("usage").insert({
                "user_id": user_id,
                "paper_id": paper_id,
                "action": action,
                "count": 1,
                "date": today_str,
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

    today_str = datetime.now(timezone.utc).date().isoformat()
    existing = _safe_single(
        client.table("usage")
        .select("count")
        .eq("user_id", user_id)
        .eq("paper_id", paper_id)
        .eq("action", action)
        .gte("date", today_str)
        .lte("date", today_str)
    )
    return (existing or {}).get("count", 0)


def get_daily_api_count(user_id: str) -> int:
    """Get total API calls for today, from the paper-independent daily table.

    Falls back to summing the legacy `usage` table if `daily_api_usage` is not
    available yet (e.g. first deploy before the migration ran), so the counter
    never regresses silently.
    """
    client = get_db()
    if not client:
        return 0

    from datetime import datetime, timezone

    today_str = datetime.now(timezone.utc).date().isoformat()

    try:
        _ensure_daily_api_usage_table(client)
        row = _safe_single(
            client.table("daily_api_usage")
            .select("count")
            .eq("user_id", user_id)
            .eq("date", today_str)
        )
        if row is not None:
            return int(row.get("count") or 0)
        # No row yet for today — still fall through to legacy sum so users who
        # were active before the new table existed don't see a sudden zero.
    except Exception as e:
        logger.debug("daily_api_usage read failed, falling back: %s", e)

    try:
        res = (
            client.table("usage")
            .select("count")
            .eq("user_id", user_id)
            .gte("date", today_str)
            .lte("date", today_str)
            .execute()
        )
        rows = (res.data if res else None) or []
        return sum(r.get("count", 0) for r in rows)
    except Exception as e:
        logger.warning("get_daily_api_count legacy fallback failed: %s", e)
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
