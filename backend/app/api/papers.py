"""API routes for paper management."""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse

from ..config import settings
from ..models.schemas import ParsedPaper
from ..services.pdf_parser import extract_pdf, get_figure_path, get_paper, list_papers, save_paper
from ..services.llm import format_paper_with_haiku

router = APIRouter(prefix="/api/papers", tags=["papers"])


@router.post("/upload", response_model=ParsedPaper)
async def upload_paper(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    paper_id = uuid.uuid4().hex[:12]
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"

    with open(pdf_path, "wb") as f:
        content = await file.read()
        f.write(content)

    try:
        raw = extract_pdf(pdf_path, paper_id)
    except Exception as e:
        pdf_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Failed to parse PDF: {e}")

    try:
        haiku_result = await format_paper_with_haiku(raw.raw_text)
    except Exception as e:
        pdf_path.unlink(missing_ok=True)
        shutil.rmtree(settings.papers_dir / paper_id, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to format paper: {e}")

    from ..models.schemas import Reference

    paper = ParsedPaper(
        id=paper_id,
        title=haiku_result["title"] or file.filename or paper_id,
        authors=haiku_result["authors"],
        affiliations=haiku_result.get("affiliations", []),
        abstract=haiku_result["abstract"],
        content_markdown=haiku_result["content_markdown"],
        figures=raw.figures,
        references=[Reference(**r) for r in haiku_result.get("references", [])],
    )

    save_paper(paper)
    return paper


@router.get("/", response_model=list[dict])
async def get_papers():
    return list_papers()


@router.get("/{paper_id}", response_model=ParsedPaper)
async def get_paper_by_id(paper_id: str):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


@router.get("/{paper_id}/figures/{fig_id}")
async def get_figure(paper_id: str, fig_id: str):
    fig_path = get_figure_path(paper_id, fig_id)
    if not fig_path:
        raise HTTPException(status_code=404, detail="Figure not found")
    return FileResponse(str(fig_path), media_type="image/png")


@router.post("/{paper_id}/si/upload", response_model=ParsedPaper)
async def upload_si(paper_id: str, file: UploadFile = File(...)):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    si_id = f"{paper_id}_si"
    si_pdf_path = settings.papers_dir / f"{si_id}.pdf"
    with open(si_pdf_path, "wb") as f:
        content = await file.read()
        f.write(content)

    try:
        raw = extract_pdf(si_pdf_path, si_id)
        si_result = await format_paper_with_haiku(raw.raw_text)

        paper.content_markdown += "\n\n---\n\n## Supplementary Information\n\n"
        paper.content_markdown += si_result["content_markdown"]
        paper.figures.extend(raw.figures)
        paper.has_si = True

        save_paper(paper)
    except Exception as e:
        si_pdf_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Failed to parse SI PDF: {e}")

    return paper


@router.delete("/{paper_id}")
async def delete_paper(paper_id: str):
    paper_dir = settings.papers_dir / paper_id
    pdf_path = settings.papers_dir / f"{paper_id}.pdf"

    if not paper_dir.exists():
        raise HTTPException(status_code=404, detail="Paper not found")

    shutil.rmtree(paper_dir)
    pdf_path.unlink(missing_ok=True)

    return {"status": "deleted", "id": paper_id}


@router.patch("/{paper_id}/folder")
async def move_to_folder(paper_id: str, body: dict):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper.folder = body.get("folder", "")
    save_paper(paper)
    return {"status": "ok", "id": paper_id, "folder": paper.folder}


@router.patch("/{paper_id}/tags")
async def update_tags(paper_id: str, body: dict):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper.tags = body.get("tags", [])
    save_paper(paper)
    return {"status": "ok", "id": paper_id, "tags": paper.tags}


@router.post("/{paper_id}/notes")
async def add_note(paper_id: str, body: dict):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    import time
    note = {
        "id": f"note_{int(time.time()*1000)}",
        "text": body.get("text", ""),
        "section": body.get("section", ""),
        "created_at": time.time(),
    }
    paper.notes.append(note)
    save_paper(paper)
    return note


@router.put("/{paper_id}/notes/{note_id}")
async def update_note(paper_id: str, note_id: str, body: dict):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    for n in paper.notes:
        if n["id"] == note_id:
            n["text"] = body.get("text", n["text"])
            save_paper(paper)
            return n

    raise HTTPException(status_code=404, detail="Note not found")


@router.delete("/{paper_id}/notes/{note_id}")
async def delete_note(paper_id: str, note_id: str):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    paper.notes = [n for n in paper.notes if n["id"] != note_id]
    save_paper(paper)
    return {"status": "deleted"}
