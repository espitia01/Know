"""API routes for paper management."""

from __future__ import annotations

import re
import shutil
import uuid

from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import FileResponse, Response

from ..config import settings
from ..models.schemas import ParsedPaper
from ..services.pdf_parser import extract_pdf, extract_figures, get_figure_path, get_paper, list_papers, save_paper
from ..services.llm import extract_metadata
from ..auth import require_auth
from ..gating import check_paper_limit, check_feature_access

router = APIRouter(prefix="/api/papers", tags=["papers"])

_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB


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
async def upload_paper(request: Request, user_id: str = Depends(require_auth)):
    check_paper_limit(user_id)
    _paper_count_incremented = True

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
            raw = extract_pdf(pdf_path, paper_id)
        except Exception as e:
            pdf_path.unlink(missing_ok=True)
            raise HTTPException(status_code=422, detail="Failed to parse PDF. Please try a different file.")

        try:
            meta = await extract_metadata(raw.raw_text, user_id=user_id)
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
        _paper_count_incremented = False
        return paper
    except Exception:
        if _paper_count_incremented:
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


@router.get("/{paper_id}", response_model=ParsedPaper)
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
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not found")
    return FileResponse(str(pdf_path), media_type="application/pdf",
                        headers={"Content-Disposition": f"inline; filename={paper_id}.pdf"})


@router.get("/{paper_id}/figures/{fig_id}")
async def get_figure(paper_id: str, fig_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _validate_id(fig_id, "fig_id")
    _verify_paper_owner(paper_id, user_id)
    fig_path = get_figure_path(paper_id, fig_id)
    if not fig_path:
        raise HTTPException(status_code=404, detail="Figure not found")
    return FileResponse(str(fig_path), media_type="image/png")


@router.delete("/{paper_id}")
async def delete_paper(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper_dir = settings.papers_dir / paper_id
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"

    if not paper_dir.exists():
        raise HTTPException(status_code=404, detail="Paper not found")

    shutil.rmtree(paper_dir)
    pdf_path.unlink(missing_ok=True)

    from ..services.db import delete_paper_meta, increment_paper_count
    delete_paper_meta(paper_id, user_id)
    increment_paper_count(user_id, delta=-1)

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
    """Re-extract figures using the improved caption-based method."""
    check_feature_access(user_id, "figures")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    import fitz as fitz_mod

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not found")

    paper_dir = settings.papers_dir / paper_id
    old_figs = paper_dir / "figures"
    if old_figs.exists():
        shutil.rmtree(old_figs)

    doc = fitz_mod.open(str(pdf_path))
    figures = extract_figures(doc, paper_dir)
    doc.close()

    paper.figures = figures
    save_paper(paper, user_id=user_id)
    return {"status": "ok", "figures_count": len(figures), "figures": [f.model_dump() for f in figures]}
