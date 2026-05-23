"""Export API routes."""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_auth
from ..gating import release_export_usage, reserve_export_usage
from ..services import storage as cloud_storage
from ..services.db import (
    ALLOWED_EXPORT_SECTIONS,
    create_export_row,
    delete_export_row,
    get_export_row,
    list_export_rows,
)
from ..services.exports.jobs import run_export_job
from .papers import _validate_id, _verify_paper_owner

router = APIRouter(tags=["exports"])
logger = logging.getLogger(__name__)

_PODCAST_VOICES = frozenset({"onyx", "nova", "alloy"})
_PODCAST_LENGTHS = frozenset({5, 8, 12})
_EXPORT_FORMATS = frozenset({"pdf", "pptx", "podcast"})


class ExportRequest(BaseModel):
    format: str
    sections: list[str] = Field(default_factory=list)
    options: dict = Field(default_factory=dict)


def _validate_sections(sections: list[str]) -> list[str]:
    if not sections:
        raise HTTPException(status_code=400, detail="At least one section is required")
    out = []
    for s in sections:
        if s not in ALLOWED_EXPORT_SECTIONS:
            raise HTTPException(status_code=400, detail=f"Invalid section: {s}")
        if s not in out:
            out.append(s)
    return out


def _normalize_options(fmt: str, options: dict) -> dict:
    opts = dict(options or {})
    if fmt == "podcast":
        pod = dict(opts.get("podcast") or {})
        length = int(pod.get("length_minutes", 8))
        if length not in _PODCAST_LENGTHS:
            length = 8
        voice = pod.get("voice", "onyx")
        if voice not in _PODCAST_VOICES:
            voice = "onyx"
        opts["podcast"] = {"length_minutes": length, "voice": voice}
    if fmt == "pdf":
        pdf = dict(opts.get("pdf") or {})
        size = pdf.get("paper_size", "Letter")
        if size not in ("Letter", "A4"):
            size = "Letter"
        opts["pdf"] = {
            "paper_size": size,
            "include_figures": bool(pdf.get("include_figures", True)),
            "compact": bool(pdf.get("compact", False)),
        }
    if fmt == "pptx":
        pptx = dict(opts.get("pptx") or {})
        theme = pptx.get("theme", "light")
        if theme not in ("light", "dark"):
            theme = "light"
        opts["pptx"] = {
            "theme": theme,
            "dense": bool(pptx.get("dense", False)),
        }
    return opts


def _export_response(row: dict, *, include_url: bool = True) -> dict:
    out = dict(row)
    if include_url and row.get("status") == "completed" and row.get("storage_path"):
        url = cloud_storage.create_signed_url(
            row["user_id"], row["storage_path"], expires_in=86400
        )
        out["download_url"] = url
    else:
        out["download_url"] = None
    return out


@router.post("/api/papers/{paper_id}/export", status_code=202)
async def create_export(
    paper_id: str,
    body: ExportRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(require_auth),
):
    paper_id = _validate_id(paper_id, "paper ID")
    _verify_paper_owner(paper_id, user_id)

    fmt = body.format
    if fmt not in _EXPORT_FORMATS:
        raise HTTPException(status_code=400, detail=f"Invalid format: {fmt}")

    sections = _validate_sections(body.sections)
    options = _normalize_options(fmt, body.options)

    token = None
    try:
        token = reserve_export_usage(user_id, fmt)
        row = create_export_row(user_id, paper_id, fmt, sections, options)
        if not row:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "export_concurrent",
                    "message": "Too many exports in progress. Wait for one to finish.",
                },
            )
        export_id = row["id"]

        if fmt == "podcast":
            import asyncio

            asyncio.create_task(run_export_job(export_id))
        else:
            background_tasks.add_task(run_export_job, export_id)

        return {"export_id": export_id}
    except HTTPException:
        if token:
            release_export_usage(token)
        raise
    except Exception:
        if token:
            release_export_usage(token)
        raise


@router.get("/api/exports/{export_id}")
async def get_export(export_id: str, user_id: str = Depends(require_auth)):
    export_id = _validate_id(export_id, "export ID")
    row = get_export_row(export_id, user_id)
    if not row:
        raise HTTPException(status_code=404, detail="Export not found")
    return _export_response(row)


@router.get("/api/exports")
async def list_exports(limit: int = 20, user_id: str = Depends(require_auth)):
    rows = list_export_rows(user_id, limit=min(limit, 50))
    return {"items": [_export_response(r) for r in rows]}


@router.delete("/api/exports/{export_id}")
async def delete_export(export_id: str, user_id: str = Depends(require_auth)):
    export_id = _validate_id(export_id, "export ID")
    row = get_export_row(export_id, user_id)
    if not row:
        raise HTTPException(status_code=404, detail="Export not found")

    if row.get("storage_path"):
        cloud_storage.delete_file(user_id, row["storage_path"])

    delete_export_row(export_id, user_id)
    return {"status": "deleted"}
