"""Supabase Storage wrapper for persisting PDFs and figure images."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

BUCKET = "papers"


def _get_bucket():
    from .db import get_db
    client = get_db()
    if not client:
        return None
    return client.storage.from_(BUCKET)


def upload_file(user_id: str, path: str, content: bytes, content_type: str = "application/octet-stream") -> bool:
    """Upload bytes to Supabase Storage. Returns True on success."""
    bucket = _get_bucket()
    if not bucket:
        logger.warning("Supabase Storage not configured — skipping upload of %s", path)
        return False

    full_path = f"{user_id}/{path}"
    try:
        bucket.upload(
            path=full_path,
            file=content,
            file_options={"content-type": content_type, "upsert": "true"},
        )
        return True
    except Exception as e:
        logger.error("Storage upload failed for %s: %s", full_path, e)
        return False


def download_file(user_id: str, path: str) -> bytes | None:
    """Download bytes from Supabase Storage. Returns None on failure/404."""
    bucket = _get_bucket()
    if not bucket:
        return None

    full_path = f"{user_id}/{path}"
    try:
        data = bucket.download(full_path)
        return data if data else None
    except Exception as e:
        logger.debug("Storage download failed for %s: %s", full_path, e)
        return None


def create_signed_url(user_id: str, path: str, expires_in: int = 600) -> str | None:
    """Create a short-lived signed URL for a private Supabase object."""
    bucket = _get_bucket()
    if not bucket:
        return None

    full_path = f"{user_id}/{path}"
    try:
        res = bucket.create_signed_url(full_path, expires_in)
        if isinstance(res, dict):
            return res.get("signedURL") or res.get("signed_url")
        return None
    except Exception as e:
        logger.debug("Storage signed URL failed for %s: %s", full_path, e)
        return None


def delete_paper_files(user_id: str, paper_id: str) -> None:
    """Delete the PDF and all figures for a paper from Supabase Storage."""
    bucket = _get_bucket()
    if not bucket:
        return

    paths_to_delete = [f"{user_id}/{paper_id}.pdf"]

    try:
        fig_files = bucket.list(f"{user_id}/{paper_id}/figures")
        if fig_files:
            for f in fig_files:
                name = f.get("name", "")
                if name:
                    paths_to_delete.append(f"{user_id}/{paper_id}/figures/{name}")
    except Exception as e:
        logger.debug("Could not list figures for deletion: %s", e)

    try:
        bucket.remove(paths_to_delete)
    except Exception as e:
        logger.error("Storage delete failed for paper %s: %s", paper_id, e)
