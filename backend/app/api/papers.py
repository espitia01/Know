"""API routes for paper management."""

from __future__ import annotations

import re
import shutil
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Depends
from fastapi.responses import FileResponse, RedirectResponse, Response

from ..config import settings
from ..models.schemas import ParsedPaper
from ..services.pdf_parser import (
    extract_pdf,
    extract_figures,
    get_figure_path,
    get_paper,
    list_papers,
    save_paper,
    _forget_paper_lock,
)
from ..services.llm import extract_metadata
from ..services import storage as cloud_storage
from ..auth import require_auth
from ..gating import check_paper_limit, check_feature_access, reserve_usage, release_usage

router = APIRouter(prefix="/api/papers", tags=["papers"])

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB


def _mirror_upload_to_storage(user_id: str, paper_id: str, content: bytes) -> None:
    """Best-effort mirror of uploaded PDF and extracted figure PNGs."""
    try:
        cloud_storage.upload_file(user_id, f"{paper_id}.pdf", content, "application/pdf")
        figures_dir = settings.papers_dir / paper_id / "figures"
        if figures_dir.exists():
            for fig_file in figures_dir.iterdir():
                if fig_file.suffix == ".png":
                    cloud_storage.upload_file(
                        user_id,
                        f"{paper_id}/figures/{fig_file.name}",
                        fig_file.read_bytes(),
                        "image/png",
                    )
    except Exception:
        # Per F-UPLOAD-LAG: storage mirroring must never turn a successful
        # local parse/save into a failed upload response.
        import logging
        logging.getLogger(__name__).exception("Storage mirror failed for paper %s", paper_id)


def _validate_id(value: str, name: str = "ID") -> str:
    """Reject IDs containing path traversal characters."""
    if not value or not _SAFE_ID_RE.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {name}")
    return value


def _verify_paper_owner(paper_id: str, user_id: str) -> None:
    """Check that the paper belongs to the requesting user via Supabase."""
    from ..services.db import get_db, get_paper_meta
    if not get_db():
        raise HTTPException(status_code=503, detail="Database unavailable")
    meta = get_paper_meta(paper_id, user_id=user_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Paper not found")


@router.post("/upload", response_model=ParsedPaper)
async def upload_paper(
    request: Request,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(require_auth),
):
    """Upload a new paper.

    ``check_paper_limit`` atomically reserves a slot in ``users.paper_count``
    (migration 009 `check_and_increment_paper_count`). If any step below
    fails, the ``finally`` block releases that slot so failed uploads don't
    permanently count against the user's cap. This also handles
    ``HTTPException`` (e.g. 400/422 validations), which a prior version
    missed because it only decremented inside a broad ``except Exception``.
    """
    check_paper_limit(user_id)
    slot_reserved = True

    try:
        content_type = request.headers.get("content-type", "")
        if "multipart/form-data" not in content_type:
            raise HTTPException(status_code=400, detail="Expected multipart/form-data")

        form = await request.form()
        file_field = form.get("file")
        if file_field is None or not hasattr(file_field, "read"):
            raise HTTPException(status_code=400, detail="No file field in form data")

        file = file_field
        filename = getattr(file, "filename", "") or ""
        if not filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files are accepted")

        paper_id = uuid.uuid4().hex
        pdf_path = settings.papers_dir / f"{paper_id}.pdf"

        content = await file.read()
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail="File too large (max 50 MB)")
        if not content[:5] == b"%PDF-":
            raise HTTPException(status_code=400, detail="Invalid PDF file")

        import asyncio
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: pdf_path.write_bytes(content))

        try:
            # Per audit §7.3: PDF parsing is CPU/disk heavy. Keep the
            # event loop free so health checks and other users' requests
            # are not blocked behind a large upload.
            raw = await loop.run_in_executor(None, extract_pdf, pdf_path, paper_id)
        except Exception:
            pdf_path.unlink(missing_ok=True)
            raise HTTPException(status_code=422, detail="Failed to parse PDF. Please try a different file.")

        try:
            # Per F-UPLOAD-LAG: metadata is nice-to-have for display, but a
            # slow upstream model should not keep the reader closed.
            meta = await asyncio.wait_for(
                extract_metadata(raw.raw_text, user_id=user_id),
                timeout=15,
            )
        except Exception:
            meta = {"title": "", "authors": []}

        paper = ParsedPaper(
            id=paper_id,
            title=meta.get("title") or filename.replace(".pdf", "") or paper_id,
            authors=meta.get("authors", []),
            raw_text=raw.raw_text,
            figures=raw.figures,
        )

        save_paper(paper, user_id=user_id)

        background_tasks.add_task(_mirror_upload_to_storage, user_id, paper_id, content)

        slot_reserved = False
        return paper
    except BaseException:
        if slot_reserved:
            try:
                from ..services.db import increment_paper_count
                increment_paper_count(user_id, -1)
            except Exception:
                pass
        raise


@router.get("/", response_model=list[dict])
async def get_papers(user_id: str = Depends(require_auth)):
    try:
        return list_papers(user_id=user_id)
    except ValueError:
        raise HTTPException(status_code=503, detail="Database unavailable")


@router.get(
    "/{paper_id}",
    response_model=ParsedPaper,
    # Per audit §6.1: raw_text is large and only used server-side for prompts.
    response_model_exclude={"raw_text"},
)
async def get_paper_by_id(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


@router.get("/{paper_id}/pdf")
async def get_paper_pdf(paper_id: str, user_id: str = Depends(require_auth)):
    """Serve the raw PDF file for the in-browser viewer."""
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    signed = cloud_storage.create_signed_url(user_id, f"{paper_id}.pdf", 600)
    if signed:
        return RedirectResponse(signed, status_code=302)

    pdf_path = settings.papers_dir / f"{paper_id}.pdf"

    if pdf_path.exists():
        return FileResponse(str(pdf_path), media_type="application/pdf",
                            headers={"Content-Disposition": f"inline; filename={paper_id}.pdf"})

    pdf_bytes = cloud_storage.download_file(user_id, f"{paper_id}.pdf")
    if pdf_bytes:
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(pdf_bytes)
        return Response(content=pdf_bytes, media_type="application/pdf",
                        headers={"Content-Disposition": f"inline; filename={paper_id}.pdf"})

    raise HTTPException(status_code=404, detail="PDF not found")


@router.get("/{paper_id}/figures/{fig_id}")
async def get_figure(paper_id: str, fig_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _validate_id(fig_id, "fig_id")
    _verify_paper_owner(paper_id, user_id)

    signed = cloud_storage.create_signed_url(user_id, f"{paper_id}/figures/{fig_id}.png", 600)
    if signed:
        return RedirectResponse(signed, status_code=302)

    fig_path = get_figure_path(paper_id, fig_id)
    if fig_path:
        return FileResponse(str(fig_path), media_type="image/png")

    fig_bytes = cloud_storage.download_file(user_id, f"{paper_id}/figures/{fig_id}.png")
    if fig_bytes:
        local_dir = settings.papers_dir / paper_id / "figures"
        local_dir.mkdir(parents=True, exist_ok=True)
        (local_dir / f"{fig_id}.png").write_bytes(fig_bytes)
        return Response(content=fig_bytes, media_type="image/png")

    raise HTTPException(status_code=404, detail="Figure not found")


@router.delete("/{paper_id}")
async def delete_paper(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper_dir = settings.papers_dir / paper_id
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"

    if paper_dir.exists():
        shutil.rmtree(paper_dir)
    pdf_path.unlink(missing_ok=True)

    cloud_storage.delete_paper_files(user_id, paper_id)

    from ..services.db import delete_paper_meta, increment_paper_count
    delete_paper_meta(paper_id, user_id)
    increment_paper_count(user_id, delta=-1)

    # L8: drop the in-memory per-paper lock now that the paper is gone; otherwise
    # _paper_locks would grow unboundedly in long-lived workers as users churn
    # through uploads.
    _forget_paper_lock(paper_id)

    return {"status": "deleted", "id": paper_id}


@router.patch("/{paper_id}/tags")
async def update_tags(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper.tags = body.get("tags", [])[:50]
    paper.tags = [t[:100] for t in paper.tags if isinstance(t, str)]
    save_paper(paper, user_id=user_id)
    return {"status": "ok", "id": paper_id, "tags": paper.tags}


@router.patch("/{paper_id}/folder")
async def update_folder(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper.folder = body.get("folder", "")[:200]
    save_paper(paper, user_id=user_id)
    return {"status": "ok", "id": paper_id, "folder": paper.folder}


@router.patch("/{paper_id}/title")
async def update_title(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Rename a paper.

    Mirrors Google Docs' inline rename behaviour: the client sends the
    full new title, we sanitize it, persist it, and echo it back so the
    caller can reconcile any trimming we performed. A blank title is
    rejected to keep the UI from rendering an unclickable empty row in
    library/session listings.
    """
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    raw = body.get("title", "")
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="title must be a string")
    # Collapse all whitespace (including stray newlines from paste) and
    # trim. Cap at a reasonable length — long enough for real paper
    # titles, short enough that it still fits in a one-line tab.
    cleaned = " ".join(raw.split()).strip()[:300]
    if not cleaned:
        raise HTTPException(status_code=400, detail="title cannot be empty")

    paper.title = cleaned
    save_paper(paper, user_id=user_id)
    return {"status": "ok", "id": paper_id, "title": paper.title}


@router.post("/{paper_id}/notes")
async def add_note(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "notes")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    import time
    note_text = body.get("text", "")[:10000]
    note = {
        "id": f"note_{int(time.time()*1000)}",
        "text": note_text,
        "section": body.get("section", "")[:500],
        "created_at": time.time(),
    }
    paper.notes.append(note)
    save_paper(paper, user_id=user_id)
    return note


@router.put("/{paper_id}/notes/{note_id}")
async def update_note(paper_id: str, note_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "notes")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    for n in paper.notes:
        if n["id"] == note_id:
            n["text"] = body.get("text", n["text"])[:10000]
            save_paper(paper, user_id=user_id)
            return n

    raise HTTPException(status_code=404, detail="Note not found")


@router.delete("/{paper_id}/notes/{note_id}")
async def delete_note(paper_id: str, note_id: str, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "notes")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper.notes = [n for n in paper.notes if n["id"] != note_id]
    save_paper(paper, user_id=user_id)
    return {"status": "deleted"}


@router.post("/{paper_id}/reextract-figures")
async def reextract_figures(paper_id: str, user_id: str = Depends(require_auth)):
    """Re-extract figures using the improved caption-based method.

    H7: This endpoint re-parses the entire PDF (potentially MB of image data)
    and rewrites cloud storage on every call. Without a reservation it was
    free to spam — a single user could loop and effectively DoS the worker's
    CPU / storage egress without touching their LLM quota. We now reserve
    against the user's daily API budget and release on any failure so a
    busted re-extract doesn't permanently debit them.
    """
    check_feature_access(user_id, "figures")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    import fitz as fitz_mod

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    token = reserve_usage(user_id, paper_id, "reextract_figures")
    try:
        pdf_path = settings.papers_dir / f"{paper_id}.pdf"
        if not pdf_path.exists():
            pdf_bytes = cloud_storage.download_file(user_id, f"{paper_id}.pdf")
            if not pdf_bytes:
                raise HTTPException(status_code=404, detail="PDF not found")
            pdf_path.parent.mkdir(parents=True, exist_ok=True)
            pdf_path.write_bytes(pdf_bytes)

        paper_dir = settings.papers_dir / paper_id
        old_figs = paper_dir / "figures"
        if old_figs.exists():
            shutil.rmtree(old_figs)

        doc = fitz_mod.open(str(pdf_path))
        figures = extract_figures(doc, paper_dir)
        doc.close()

        for fig in figures:
            fig_file = paper_dir / "figures" / f"{fig.id}.png"
            if fig_file.exists():
                cloud_storage.upload_file(
                    user_id,
                    f"{paper_id}/figures/{fig_file.name}",
                    fig_file.read_bytes(),
                    "image/png",
                )

        paper.figures = figures
        save_paper(paper, user_id=user_id)
        return {"status": "ok", "figures_count": len(figures), "figures": [f.model_dump() for f in figures]}
    except BaseException:
        try:
            release_usage(token)
        except Exception:
            pass
        raise
