"""Async export job dispatcher."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from ...gating import release_export_usage
from .. import storage as cloud_storage
from ..db import get_export_row_by_id, update_export_row
from ..pdf_parser import get_paper
from .content import gather_export_context
from .pdf_render import render_pdf
from .pptx_render import render_pptx
from .podcast_render import filter_segments, render_podcast, validate_podcast_script

logger = logging.getLogger(__name__)

_EXT = {"pdf": "pdf", "pptx": "pptx", "podcast": "mp3"}
_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "podcast": "audio/mpeg",
}


async def run_export_job(export_id: str) -> None:
    """Pick up a pending export, render, upload, mark completed or failed."""
    row = get_export_row_by_id(export_id)
    if not row:
        logger.warning("export job missing row export_id=%s", export_id)
        return

    status = row.get("status")
    if status in ("completed", "failed"):
        return

    user_id = row["user_id"]
    paper_id = row["paper_id"]
    fmt = row["format"]

    update_export_row(export_id, user_id, {"status": "running"})

    try:
        paper = get_paper(paper_id, user_id=user_id)
        if not paper:
            raise RuntimeError("paper_not_found")
        cache = gather_export_context(paper, user_id, row.get("sections") or [])

        duration_s = None
        if fmt == "pdf":
            data, ctype, filename = render_pdf(row, paper, cache)
        elif fmt == "pptx":
            try:
                from .latex_render import LatexUnavailable, render_beamer_pdf

                data, ctype, filename = render_beamer_pdf(row, paper, cache)
            except LatexUnavailable:
                data, ctype, filename = render_pptx(row, paper, cache)
        elif fmt == "podcast":
            from ...services.llm import generate_podcast_script

            sections = row.get("sections") or []
            opts = row.get("options") or {}
            target = int((opts.get("podcast") or {}).get("length_minutes", 8))
            segments, meta = await generate_podcast_script(
                paper, sections, target_minutes=target, user_id=user_id, cache=cache,
            )
            segments = filter_segments(segments)
            ok, reason = validate_podcast_script(segments)
            if not ok:
                raise RuntimeError(f"script_invalid:{reason}")
            data, ctype, filename, duration_s = await render_podcast(row, paper, segments)
            logger.info(
                "podcast_export_done export_id=%s words_total=%s regenerations=%s",
                export_id,
                meta.get("words_total"),
                meta.get("regenerations"),
            )
        else:
            raise RuntimeError("unknown_format")

        ext = "pdf" if ctype == "application/pdf" else _EXT.get(fmt, fmt)
        storage_path = f"exports/{export_id}.{ext}"
        ok = cloud_storage.upload_file(user_id, storage_path, data, ctype)
        if not ok:
            raise RuntimeError("upload_failed")

        patch = {
            "status": "completed",
            "storage_path": storage_path,
            "byte_size": len(data),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "error_code": None,
            "error_message": None,
        }
        if duration_s is not None:
            patch["duration_s"] = duration_s
        update_export_row(export_id, user_id, patch)
        logger.info(
            "export_completed export_id=%s format=%s byte_size=%s",
            export_id, fmt, len(data),
        )
    except Exception as exc:
        code = getattr(exc, "code", None) or str(exc).split(":")[0]
        logger.exception(
            "export_failed export_id=%s format=%s error_code=%s",
            export_id, fmt, code,
        )
        release_export_usage({
            "user_id": user_id,
            "format": fmt,
            "today": datetime.now(timezone.utc).date().isoformat(),
            "count": 1,
        })
        update_export_row(
            export_id,
            user_id,
            {
                "status": "failed",
                "error_code": str(code)[:64],
                "error_message": str(exc)[:500],
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
