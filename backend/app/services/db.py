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
    """Atomically check the paper limit and increment if under. Returns True on
    success, False when the cap is reached or the DB is unreachable.

    Enforcement is centralized in the SQL function (migration 009): one
    ``UPDATE ... WHERE paper_count < max`` with ``RETURNING`` gives us check
    and increment in a single statement, so concurrent uploads can't race past
    the cap. Previously a Python fallback read the count and then wrote it
    separately, which was a TOCTOU window under any concurrency.
    """
    client = get_db()
    if not client:
        return False

    try:
        res = client.rpc("check_and_increment_paper_count", {
            "uid": user_id, "max_count": int(max_papers),
        }).execute()
    except Exception as e:
        logger.error(
            "check_and_increment_paper_count RPC failed for %s: %s", user_id, e,
        )
        return False

    if not res or res.data is None:
        return False

    data = res.data
    if isinstance(data, list) and data:
        data = list(data[0].values())[0] if isinstance(data[0], dict) else data[0]
    return bool(data)


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


def get_paper_meta(paper_id: str, user_id: str) -> dict | None:
    """Fetch a paper row scoped to ``user_id``.

    ``user_id`` is required — the service-role key bypasses RLS, so every
    query must filter by owner explicitly. A prior version allowed
    ``user_id=None`` for internal callers, which was a latent IDOR footgun.
    """
    client = get_db()
    if not client:
        return None
    if not user_id:
        raise ValueError("get_paper_meta requires user_id")

    return _safe_single(
        client.table("papers").select("*").eq("id", paper_id).eq("user_id", user_id)
    )


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


MAX_LIST_LIMIT = 500


def list_papers_meta(
    user_id: str, *, limit: int = MAX_LIST_LIMIT, offset: int = 0,
) -> list[dict]:
    """Return the user's papers, newest first.

    The list is bounded by ``limit`` (hard-capped at ``MAX_LIST_LIMIT``) so a
    runaway library can't produce a multi-megabyte response or pin a worker
    on the JSONB deserialize path.
    """
    client = get_db()
    if not client:
        return []

    limit = max(1, min(int(limit or MAX_LIST_LIMIT), MAX_LIST_LIMIT))
    offset = max(0, int(offset or 0))

    try:
        res = (
            client.table("papers")
            .select("id, title, folder, tags, authors, notes, created_at")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
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
    """Delete a paper row. Also prunes the id from any workspace arrays so
    deleted papers don't leave dead references in `workspaces.paper_ids`
    (JSONB arrays don't participate in foreign keys)."""
    client = get_db()
    if not client:
        return
    client.table("papers").delete().eq("id", paper_id).eq("user_id", user_id).execute()
    try:
        remove_paper_from_workspaces(paper_id, user_id)
    except Exception as e:
        logger.warning(
            "Failed to prune paper %s from workspaces for %s: %s",
            paper_id, user_id, e,
        )


def remove_paper_from_workspaces(paper_id: str, user_id: str) -> None:
    """Remove ``paper_id`` from every workspace's ``paper_ids`` array.

    Scans workspaces owned by ``user_id`` and rewrites any whose array still
    contains the deleted id. We do this in Python because Supabase's
    PostgREST interface doesn't cleanly expose `jsonb - element` operators,
    and the user's workspace count is always small (O(10-100)).
    """
    client = get_db()
    if not client:
        return
    try:
        res = (
            client.table("workspaces")
            .select("id, paper_ids")
            .eq("user_id", user_id)
            .execute()
        )
        rows = (res.data if res else None) or []
    except Exception as e:
        logger.warning("workspace scan for paper pruning failed: %s", e)
        return

    for row in rows:
        ids = row.get("paper_ids") or []
        if not isinstance(ids, list) or paper_id not in ids:
            continue
        new_ids = [pid for pid in ids if pid != paper_id]
        try:
            client.table("workspaces").update({"paper_ids": new_ids}).eq(
                "id", row["id"]
            ).eq("user_id", user_id).execute()
        except Exception as e:
            logger.warning(
                "Failed to prune paper %s from workspace %s: %s",
                paper_id, row.get("id"), e,
            )


# ----------------------------------------------------------------
# Usage tracking (for free-tier rate limits)
# ----------------------------------------------------------------

_daily_api_bootstrap_done = False


def _ensure_daily_api_usage_table(client) -> None:
    """Cheap existence probe for `daily_api_usage`.

    The table + reserve/release RPCs live in migrations 006 / 008. We used to
    run `exec_sql` to self-heal the schema when the migration hadn't been
    applied, but that relied on an undocumented DDL-through-RPC hatch that's
    a hidden superuser endpoint from the app's perspective. It's gone — apply
    the migrations via your Supabase CLI instead.
    """
    global _daily_api_bootstrap_done
    if _daily_api_bootstrap_done:
        return
    try:
        client.table("daily_api_usage").select("user_id").limit(1).execute()
    except Exception as e:
        logger.warning(
            "daily_api_usage not reachable; run migrations 006+008 to enable "
            "atomic daily-API-call limits: %s", e,
        )
    _daily_api_bootstrap_done = True


_daily_model_bootstrap_done = False


def _ensure_daily_model_usage_table(client) -> None:
    """Cheap existence probe for `daily_model_usage`. See the docstring on
    `_ensure_daily_api_usage_table` for why we no longer self-heal."""
    global _daily_model_bootstrap_done
    if _daily_model_bootstrap_done:
        return
    try:
        client.table("daily_model_usage").select("user_id").limit(1).execute()
    except Exception as e:
        logger.warning(
            "daily_model_usage not reachable; run migrations 006+008 to "
            "enable atomic per-model caps: %s", e,
        )
    _daily_model_bootstrap_done = True


def get_daily_model_count(user_id: str, model: str) -> int:
    """Return today's API-call count for a specific model, or raise on DB
    errors for the display API to translate into a 5xx. We deliberately do NOT
    swallow read failures to zero here: that would paint the usage UI as
    "0 used" when the cap has actually been reached, which is misleading and
    delays the user noticing a platform issue.

    Returns 0 cleanly only when Supabase isn't configured at all (local dev).
    """
    if not model:
        return 0
    client = get_db()
    if not client:
        return 0

    from datetime import datetime, timezone
    today_str = datetime.now(timezone.utc).date().isoformat()

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
    return 0


def reserve_daily_api_usage(
    user_id: str, today_str: str, delta: int, max_calls: int
) -> int:
    """Atomically reserve `delta` daily API calls and return the new total.

    Returns -1 when the reservation would exceed ``max_calls``. Raises on DB
    connectivity errors — enforcement is fail-closed by design because a
    silent fallback to "no cap" would be worse than a short outage.

    ``max_calls = -1`` means unlimited (Researcher-equivalent).
    """
    if delta <= 0:
        return 0
    client = get_db()
    if not client:
        # No DB configured → can't enforce → refuse.
        return -1
    _ensure_daily_api_usage_table(client)
    res = client.rpc("reserve_daily_api_usage", {
        "p_user_id": user_id,
        "p_date": today_str,
        "p_delta": int(delta),
        "p_max": int(max_calls),
    }).execute()
    if res and res.data is not None:
        # RPC returns either scalar int or [{"reserve_daily_api_usage": int}]
        data = res.data
        if isinstance(data, list) and data:
            data = list(data[0].values())[0] if isinstance(data[0], dict) else data[0]
        return int(data)
    return -1


def release_daily_api_usage(user_id: str, today_str: str, delta: int) -> None:
    """Undo a prior ``reserve_daily_api_usage`` so a failed LLM call doesn't
    leave the user debited. Best-effort (logs on failure) because we never
    want compensation errors to mask the original exception."""
    if delta <= 0:
        return
    client = get_db()
    if not client:
        return
    try:
        client.rpc("release_daily_api_usage", {
            "p_user_id": user_id,
            "p_date": today_str,
            "p_delta": int(delta),
        }).execute()
    except Exception as e:
        logger.error("release_daily_api_usage failed for %s: %s", user_id, e)


def reserve_daily_model_usage(
    user_id: str, today_str: str, model: str, delta: int, max_calls: int
) -> int:
    """Atomic per-model daily reservation. See ``reserve_daily_api_usage``."""
    if delta <= 0 or not model:
        return 0
    client = get_db()
    if not client:
        return -1
    _ensure_daily_model_usage_table(client)
    res = client.rpc("reserve_daily_model_usage", {
        "p_user_id": user_id,
        "p_date": today_str,
        "p_model": model,
        "p_delta": int(delta),
        "p_max": int(max_calls),
    }).execute()
    if res and res.data is not None:
        data = res.data
        if isinstance(data, list) and data:
            data = list(data[0].values())[0] if isinstance(data[0], dict) else data[0]
        return int(data)
    return -1


def release_daily_model_usage(
    user_id: str, today_str: str, model: str, delta: int
) -> None:
    """Undo a prior per-model reservation."""
    if delta <= 0 or not model:
        return
    client = get_db()
    if not client:
        return
    try:
        client.rpc("release_daily_model_usage", {
            "p_user_id": user_id,
            "p_date": today_str,
            "p_model": model,
            "p_delta": int(delta),
        }).execute()
    except Exception as e:
        logger.error("release_daily_model_usage failed for %s/%s: %s", user_id, model, e)


def reserve_paper_usage(
    user_id: str, paper_id: str, action: str,
    today_str: str, delta: int, max_count: int,
) -> int:
    """Atomic per-paper per-action reservation. ``max_count = -1`` = unlimited."""
    if delta <= 0:
        return 0
    client = get_db()
    if not client:
        return -1
    res = client.rpc("reserve_paper_usage", {
        "p_user_id": user_id,
        "p_paper_id": paper_id,
        "p_action": action,
        "p_date": today_str,
        "p_delta": int(delta),
        "p_max": int(max_count),
    }).execute()
    if res and res.data is not None:
        data = res.data
        if isinstance(data, list) and data:
            data = list(data[0].values())[0] if isinstance(data[0], dict) else data[0]
        return int(data)
    return -1


def release_paper_usage(
    user_id: str, paper_id: str, action: str, today_str: str, delta: int
) -> None:
    """Undo a prior per-paper reservation."""
    if delta <= 0:
        return
    client = get_db()
    if not client:
        return
    try:
        client.rpc("release_paper_usage", {
            "p_user_id": user_id,
            "p_paper_id": paper_id,
            "p_action": action,
            "p_date": today_str,
            "p_delta": int(delta),
        }).execute()
    except Exception as e:
        logger.error(
            "release_paper_usage failed for %s/%s/%s: %s",
            user_id, paper_id, action, e,
        )


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


def list_workspaces(
    user_id: str, *, limit: int = MAX_LIST_LIMIT, offset: int = 0,
) -> list[dict]:
    """List workspaces for a user, newest first, bounded by ``limit``."""
    client = get_db()
    if not client:
        return []

    limit = max(1, min(int(limit or MAX_LIST_LIMIT), MAX_LIST_LIMIT))
    offset = max(0, int(offset or 0))
    try:
        res = (
            client.table("workspaces")
            .select("id, name, paper_ids, cross_paper_results, updated_at, created_at")
            .eq("user_id", user_id)
            .order("updated_at", desc=True)
            .range(offset, offset + limit - 1)
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


def save_workspace_by_owner(workspace_id: str, user_id: str, name: str,
                            paper_ids: list[str], cross_paper_results: list[dict]) -> dict | None:
    """Helper used when the caller has already verified the workspace belongs
    to ``user_id`` — skips the existence check in ``save_workspace`` so a
    cross-user id collision can be surfaced as 404 upstream instead of
    conflating with a 500."""
    return save_workspace(
        user_id=user_id,
        workspace_id=workspace_id,
        name=name,
        paper_ids=paper_ids,
        cross_paper_results=cross_paper_results,
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


# ----------------------------------------------------------------
# Stripe webhook idempotency (migration 009)
# ----------------------------------------------------------------

def mark_stripe_event_processed(event_id: str, event_type: str) -> bool:
    """Record that we've fully processed this Stripe event. Returns False if
    the event was already recorded (caller should short-circuit and skip
    re-processing side effects).

    We rely on the table's PK (`event_id`) to make this atomic: the INSERT
    fails with a unique-violation on replays, which we translate to "already
    processed" without touching the row.
    """
    client = get_db()
    if not client:
        # No DB → can't dedupe. Err on the side of processing; the caller's
        # side effects are generally idempotent (tier updates are set, not
        # increment) so this is acceptable.
        return True
    try:
        client.table("processed_stripe_events").insert({
            "event_id": event_id,
            "event_type": event_type,
        }).execute()
        return True
    except Exception as e:
        msg = str(e).lower()
        if "duplicate" in msg or "23505" in msg or "unique" in msg:
            return False
        logger.warning("stripe event dedup insert failed (processing anyway): %s", e)
        return True


def is_stripe_event_processed(event_id: str) -> bool:
    """Cheap lookup: was this Stripe event already handled? Used as a fast
    short-circuit before we bother parsing the event body."""
    if not event_id:
        return False
    client = get_db()
    if not client:
        return False
    try:
        res = (
            client.table("processed_stripe_events")
            .select("event_id")
            .eq("event_id", event_id)
            .limit(1)
            .execute()
        )
        rows = (res.data if res else None) or []
        return bool(rows)
    except Exception as e:
        logger.debug("is_stripe_event_processed check failed: %s", e)
        return False
