"""API routes for paper management."""

from __future__ import annotations

import logging
import re
import shutil
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Depends, File, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response

from ..config import settings
from ..models.schemas import ParsedPaper, FigureInfo
from ..services.pdf_parser import (
    append_capped,
    extract_pdf,
    extract_figures,
    get_figure_path,
    get_paper,
    list_papers,
    load_ocr_image_bytes,
    MAX_FIGURES_PER_PAPER,
    mutate_paper,
    paper_prompt_text,
    save_paper,
    _forget_paper_lock,
)
from ..services.ocr_mistral import MistralOcrUnavailable, run_mistral_ocr, validate_ocr_image_id
from ..services.llm import extract_metadata, polish_note_from_selection, _sanitize_user_text
from ..services import storage as cloud_storage
from ..auth import require_auth
from ..gating import (
    check_paper_limit,
    check_feature_access,
    reserve_usage,
    release_usage,
    resolve_fast_model,
)

router = APIRouter(prefix="/api/papers", tags=["papers"])

logger = logging.getLogger(__name__)

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
        ocr_dir = settings.papers_dir / paper_id / "ocr"
        if ocr_dir.exists():
            for img_file in ocr_dir.iterdir():
                if img_file.suffix == ".png":
                    cloud_storage.upload_file(
                        user_id,
                        f"{paper_id}/ocr/{img_file.name}",
                        img_file.read_bytes(),
                        "image/png",
                    )
    except Exception:
        # Per F-UPLOAD-LAG: storage mirroring must never turn a successful
        # local parse/save into a failed upload response.
        import logging
        logging.getLogger(__name__).exception("Storage mirror failed for paper %s", paper_id)


async def _ocr_upload_fields(
    content: bytes,
    paper_id: str,
    user_id: str | None,
) -> dict:
    """Run Mistral OCR and return ParsedPaper OCR field values."""
    import asyncio

    if not (settings.mistral_api_key or "").strip():
        return {
            "markdown": "",
            "page_markdown": [],
            "ocr_images": [],
            "ocr_status": "unsupported",
            "ocr_model": "",
        }

    try:
        ocr = await asyncio.wait_for(
            run_mistral_ocr(content, paper_id, user_id),
            timeout=180,
        )
        if not ocr.markdown.strip():
            raise RuntimeError("mistral_ocr_empty_markdown")
        return {
            "markdown": ocr.markdown,
            "page_markdown": ocr.page_markdown,
            "ocr_images": ocr.images,
            "ocr_status": "ready",
            "ocr_model": ocr.model,
        }
    except MistralOcrUnavailable:
        return {
            "markdown": "",
            "page_markdown": [],
            "ocr_images": [],
            "ocr_status": "unsupported",
            "ocr_model": "",
        }
    except Exception as exc:
        logger.warning("Mistral OCR failed for %s: %s", paper_id, exc)
        return {
            "markdown": "",
            "page_markdown": [],
            "ocr_images": [],
            "ocr_status": "failed",
            "ocr_model": "",
        }


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
            text_for_meta = raw.raw_text
            meta = await asyncio.wait_for(
                extract_metadata(text_for_meta, user_id=user_id),
                timeout=15,
            )
        except Exception:
            meta = {"title": "", "authors": []}

        ocr_fields = await _ocr_upload_fields(content, paper_id, user_id)
        if ocr_fields["markdown"]:
            try:
                meta = await asyncio.wait_for(
                    extract_metadata(ocr_fields["markdown"][:4000], user_id=user_id),
                    timeout=15,
                )
            except Exception:
                pass

        paper = ParsedPaper(
            id=paper_id,
            title=meta.get("title") or filename.replace(".pdf", "") or paper_id,
            authors=meta.get("authors", []),
            raw_text=raw.raw_text,
            figures=raw.figures,
            **ocr_fields,
        )

        save_paper(paper, user_id=user_id)

        background_tasks.add_task(_mirror_upload_to_storage, user_id, paper_id, content)
        background_tasks.add_task(_embed_paper_background, user_id, paper_id)

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
    response_model_exclude={"raw_text", "markdown", "page_markdown"},
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


@router.get("/{paper_id}/markdown")
async def get_paper_markdown(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return {
        "markdown": paper.markdown,
        "page_markdown": paper.page_markdown,
        "images": [i.model_dump() for i in paper.ocr_images],
        "ocr_status": paper.ocr_status,
    }


@router.get("/{paper_id}/ocr-image/{image_id}")
async def get_paper_ocr_image(
    paper_id: str,
    image_id: str,
    user_id: str = Depends(require_auth),
):
    _validate_id(paper_id, "paper_id")
    try:
        validate_ocr_image_id(image_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid image id")
    _verify_paper_owner(paper_id, user_id)

    signed = cloud_storage.create_signed_url(user_id, f"{paper_id}/ocr/{image_id}", 600)
    if signed:
        return RedirectResponse(signed, status_code=302)

    img_bytes = load_ocr_image_bytes(paper_id, image_id, user_id)
    if img_bytes:
        return Response(content=img_bytes, media_type="image/png")

    raise HTTPException(status_code=404, detail="OCR image not found")


@router.post("/{paper_id}/ocr/run")
async def run_paper_ocr(paper_id: str, user_id: str = Depends(require_auth)):
    """Lazy OCR for legacy papers or retries after failure."""
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    if paper.ocr_status == "ready" and paper.markdown.strip():
        return {"ocr_status": "ready", "markdown_length": len(paper.markdown)}

    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    content = pdf_path.read_bytes() if pdf_path.exists() else cloud_storage.download_file(user_id, f"{paper_id}.pdf")
    if not content:
        raise HTTPException(status_code=404, detail="PDF not found")

    ocr_fields = await _ocr_upload_fields(content, paper_id, user_id)

    def _apply(p: ParsedPaper) -> None:
        p.markdown = ocr_fields["markdown"]
        p.page_markdown = ocr_fields["page_markdown"]
        p.ocr_images = ocr_fields["ocr_images"]
        p.ocr_status = ocr_fields["ocr_status"]
        p.ocr_model = ocr_fields["ocr_model"]

    try:
        mutate_paper(paper_id, user_id, _apply)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Paper not found") from None

    return {
        "ocr_status": ocr_fields["ocr_status"],
        "markdown_length": len(ocr_fields["markdown"]),
    }


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


@router.post("/{paper_id}/figures/from-selection")
async def upload_figure_from_selection(
    paper_id: str,
    user_id: str = Depends(require_auth),
    file: UploadFile = File(...),
):
    """Save a PNG cut from an in-browser PDF selection as a synthetic figure."""

    check_feature_access(user_id, "figures")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    content = await file.read()
    png_magic = b"\x89PNG\r\n\x1a\n"
    if len(content) < len(png_magic) + 64 or len(content) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Invalid PNG payload")
    if not content.startswith(png_magic):
        raise HTTPException(status_code=400, detail="PNG image required")

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    if len(paper.figures) >= MAX_FIGURES_PER_PAPER:
        raise HTTPException(status_code=400, detail="Figure limit reached")

    fig_id = f"clip{uuid.uuid4().hex}"
    _validate_id(fig_id, "fig_id")

    info = FigureInfo(
        id=fig_id,
        url=f"/api/papers/{paper_id}/figures/{fig_id}",
        caption="Selection from PDF",
        page=0,
    )

    figures_dir = settings.papers_dir / paper_id / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    fig_path = figures_dir / f"{fig_id}.png"

    def _apply(p: ParsedPaper) -> None:
        p.figures = [*p.figures, info]

    try:
        fig_path.write_bytes(content)
        updated = mutate_paper(paper_id, user_id, _apply)
    except Exception:
        fig_path.unlink(missing_ok=True)
        raise

    try:
        cloud_storage.upload_file(
            user_id,
            f"{paper_id}/figures/{fig_id}.png",
            content,
            "image/png",
        )
    except Exception:
        logger.warning("Cloud mirror failed for pasted figure %s/%s", paper_id, fig_id, exc_info=True)

    return {
        "figure": info.model_dump(),
        "figures": [f.model_dump() for f in updated.figures],
    }


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

    from ..services.db import delete_paper_meta, increment_paper_count, delete_reading_state
    delete_paper_meta(paper_id, user_id)
    increment_paper_count(user_id, delta=-1)
    delete_reading_state(user_id, paper_id)

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

    raw = body.get("text", "")
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="text must be a string")
    trimmed = raw.strip()
    if not trimmed:
        raise HTTPException(status_code=400, detail="note text cannot be empty")

    refine = bool(body.get("refine"))
    import time

    token = None
    if refine:
        token = reserve_usage(
            user_id, paper_id, "api_call", model=resolve_fast_model(user_id)
        )
        try:
            note_text = await polish_note_from_selection(
                paper_prompt_text(paper), trimmed, user_id=user_id
            )
            if not note_text.strip():
                raise ValueError("empty polish result")
        except ValueError as exc:
            if token:
                release_usage(token)
            logger.warning("Note polish 503 for paper %s: %s", paper_id, exc)
            raise HTTPException(
                status_code=503, detail="Notes service temporarily unavailable."
            ) from exc
        except HTTPException:
            if token:
                release_usage(token)
            raise
        except Exception:
            if token:
                release_usage(token)
            logger.exception("Note polish failed for paper %s", paper_id)
            raise HTTPException(
                status_code=500, detail="Failed to polish note."
            ) from None
    else:
        note_text = trimmed[:10000]

    note_id = f"note_{int(time.time() * 1000)}"
    note = {
        "id": note_id,
        "text": note_text.strip()[:10000],
        "section": (body.get("section") or "")[:500]
        if isinstance(body.get("section"), str)
        else "",
        "created_at": time.time(),
    }

    entry = {
        "action": "note",
        "selected_text": trimmed[:10000],
        "explanation": note["text"],
        "streaming": False,
        "clientKey": note_id,
    }

    def _apply(p):
        p.notes.append(note)
        if refine:
            append_capped(p.cached_analysis, "selections", entry)

    try:
        mutate_paper(paper_id, user_id, _apply)
    except FileNotFoundError:
        if token:
            release_usage(token)
        raise HTTPException(status_code=404, detail="Paper not found") from None
    except Exception:
        if token:
            release_usage(token)
        raise

    return note


@router.put("/{paper_id}/notes/{note_id}")
async def update_note(paper_id: str, note_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "notes")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    raw_new = body.get("text")
    if raw_new is not None and not isinstance(raw_new, str):
        raise HTTPException(status_code=400, detail="text must be a string")

    holder: dict = {}

    def _apply_put(p):
        for n in p.notes:
            if n["id"] != note_id:
                continue
            if isinstance(raw_new, str):
                n["text"] = raw_new.strip()[:10000]
            items = p.cached_analysis.get("selections") or []
            synced = []
            for s in items:
                if not isinstance(s, dict):
                    synced.append(s)
                    continue
                if s.get("clientKey") == note_id and s.get("action") == "note":
                    u = dict(s)
                    u["explanation"] = n["text"]
                    u["streaming"] = False
                    synced.append(u)
                    continue
                synced.append(s)
            p.cached_analysis["selections"] = synced
            holder["note"] = dict(n)
            return
        return

    try:
        mutate_paper(paper_id, user_id, _apply_put)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Paper not found")
    if "note" not in holder:
        raise HTTPException(status_code=404, detail="Note not found")
    return holder["note"]


@router.delete("/{paper_id}/notes/{note_id}")
async def delete_note(paper_id: str, note_id: str, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "notes")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    ok_holder: dict = {"ok": False}

    def _apply_del(p):
        before = len(p.notes)
        p.notes = [n for n in p.notes if n["id"] != note_id]
        if len(p.notes) == before:
            return
        items = p.cached_analysis.get("selections") or []
        p.cached_analysis["selections"] = [
            s
            for s in items
            if not (
                isinstance(s, dict)
                and s.get("clientKey") == note_id
                and s.get("action") == "note"
            )
        ]
        ok_holder["ok"] = True

    try:
        mutate_paper(paper_id, user_id, _apply_del)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Paper not found")
    if not ok_holder["ok"]:
        raise HTTPException(status_code=404, detail="Note not found")
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


async def _embed_paper_background(user_id: str, paper_id: str) -> None:
    try:
        from ..services.retrieval import embed_paper
        from ..services.embeddings import EmbeddingProviderError

        paper = get_paper(paper_id, user_id=user_id)
        if not paper or not (paper.raw_text or "").strip():
            return
        await embed_paper(paper_id, user_id, paper.raw_text)
    except EmbeddingProviderError:
        logger.info("Skipping embed for %s — provider not configured", paper_id)
    except Exception:
        logger.debug("Background embed failed for %s", paper_id, exc_info=True)


_HIGHLIGHT_COLORS = frozenset({"yellow", "green", "blue", "pink"})


@router.get("/{paper_id}/highlights")
async def list_paper_highlights(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    from ..services.db import list_highlights

    return {"items": list_highlights(user_id, paper_id)}


@router.post("/{paper_id}/highlights")
async def create_paper_highlight(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    from ..services.db import create_highlight

    selected = _sanitize_user_text(str(body.get("selected_text") or ""), max_chars=4000)
    if not selected:
        raise HTTPException(status_code=400, detail="selected_text required")
    color = str(body.get("color") or "yellow").strip().lower()
    if color not in _HIGHLIGHT_COLORS:
        color = "yellow"
    note_raw = body.get("note")
    note = _sanitize_user_text(str(note_raw), max_chars=2000) if note_raw else None
    page_hint = body.get("page_hint")
    page = int(page_hint) if isinstance(page_hint, int) or (
        isinstance(page_hint, str) and str(page_hint).isdigit()
    ) else None

    row = create_highlight(
        user_id, paper_id,
        selected_text=selected, color=color, note=note, page_hint=page,
    )
    if not row:
        raise HTTPException(status_code=500, detail="Failed to create highlight")
    return row


@router.patch("/{paper_id}/highlights/{highlight_id}")
async def update_paper_highlight(
    paper_id: str, highlight_id: str, body: dict, user_id: str = Depends(require_auth),
):
    _validate_id(paper_id, "paper_id")
    _validate_id(highlight_id, "highlight_id")
    _verify_paper_owner(paper_id, user_id)
    from ..services.db import update_highlight

    color = body.get("color")
    if color is not None:
        color = str(color).strip().lower()
        if color not in _HIGHLIGHT_COLORS:
            color = "yellow"
    note = body.get("note")
    if note is not None:
        note = _sanitize_user_text(str(note), max_chars=2000)

    row = update_highlight(user_id, paper_id, highlight_id, color=color, note=note)
    if not row:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return row


@router.get("/{paper_id}/reading-state")
async def get_paper_reading_state(paper_id: str, user_id: str = Depends(require_auth)):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    from ..services.db import get_reading_state

    row = get_reading_state(user_id, paper_id)
    if not row:
        raise HTTPException(status_code=404, detail="No reading state")
    return row


@router.put("/{paper_id}/reading-state")
async def put_paper_reading_state(
    paper_id: str, body: dict, user_id: str = Depends(require_auth),
):
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    from ..services.db import ALLOWED_READING_TABS, upsert_reading_state

    last_page_raw = body.get("last_page", 1)
    try:
        last_page = max(1, int(last_page_raw))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="last_page must be a positive integer")

    last_tab_raw = body.get("last_tab")
    if last_tab_raw is not None and last_tab_raw not in ALLOWED_READING_TABS:
        raise HTTPException(status_code=400, detail="invalid last_tab")
    last_tab = last_tab_raw if isinstance(last_tab_raw, str) else None

    scroll_pct: float | None = None
    sp = body.get("scroll_pct")
    if sp is not None:
        try:
            scroll_pct = max(0.0, min(1.0, float(sp)))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="scroll_pct must be a float")

    row = upsert_reading_state(
        user_id, paper_id,
        last_page=last_page, last_tab=last_tab, scroll_pct=scroll_pct,
    )
    if not row:
        raise HTTPException(status_code=500, detail="Failed to save reading state")
    return row


@router.delete("/{paper_id}/highlights/{highlight_id}")
async def delete_paper_highlight(
    paper_id: str, highlight_id: str, user_id: str = Depends(require_auth),
):
    _validate_id(paper_id, "paper_id")
    _validate_id(highlight_id, "highlight_id")
    _verify_paper_owner(paper_id, user_id)
    from ..services.db import delete_highlight

    if not delete_highlight(user_id, paper_id, highlight_id):
        raise HTTPException(status_code=404, detail="Highlight not found")
    return {"status": "deleted"}
