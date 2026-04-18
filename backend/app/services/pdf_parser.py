"""PDF parsing service using PyMuPDF (fitz)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import fitz  # pymupdf

from ..config import settings
from ..models.schemas import FigureInfo, ParsedPaper


@dataclass
class RawExtraction:
    raw_text: str
    figures: list[FigureInfo] = field(default_factory=list)


_FIG_CAPTION_RE = re.compile(
    r"^\s*(?:Figure|Fig\.?|FIG\.?)\s*(\d+)\b",
    re.IGNORECASE,
)

RENDER_SCALE = 2.0
MIN_FIGURE_PNG_BYTES = 10_000


def _find_caption_blocks(page: fitz.Page) -> list[dict]:
    """Find text blocks that begin with a figure caption label."""
    blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]
    captions: list[dict] = []

    for block in blocks:
        if block.get("type") != 0:
            continue
        text = ""
        for line in block["lines"]:
            for span in line["spans"]:
                text += span["text"]
        text = text.strip()

        m = _FIG_CAPTION_RE.match(text)
        if m:
            captions.append({
                "num": int(m.group(1)),
                "bbox": fitz.Rect(block["bbox"]),
                "text": text,
            })

    captions.sort(key=lambda c: c["bbox"].y0)
    return captions


def _image_rects_on_page(page: fitz.Page) -> list[fitz.Rect]:
    """Collect bounding rectangles of all images drawn on this page."""
    rects: list[fitz.Rect] = []
    for img in page.get_images(full=True):
        xref = img[0]
        try:
            for r in page.get_image_rects(xref):
                if not r.is_empty and not r.is_infinite:
                    rects.append(r)
        except Exception:
            pass
    return rects


def extract_figures(doc: fitz.Document, paper_dir: Path) -> list[FigureInfo]:
    """Extract whole figures by detecting captions and rendering page regions.

    Instead of pulling individual embedded images (which splits composite
    figures), this finds "Figure N" / "Fig. N" captions, determines the
    bounding region of the complete figure, and renders that page clip as
    a single PNG.
    """
    figures_dir = paper_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)

    figures: list[FigureInfo] = []
    seen_nums: set[int] = set()
    mat = fitz.Matrix(RENDER_SCALE, RENDER_SCALE)

    for page_num in range(len(doc)):
        page = doc[page_num]
        captions = _find_caption_blocks(page)
        if not captions:
            continue

        img_rects = _image_rects_on_page(page)
        page_rect = page.rect

        for i, cap in enumerate(captions):
            fig_num = cap["num"]
            if fig_num in seen_nums:
                continue
            seen_nums.add(fig_num)

            cap_rect = cap["bbox"]
            bottom = min(cap_rect.y1 + 4, page_rect.y1)

            # Top boundary: previous caption bottom, or page top
            if i > 0:
                boundary_top = captions[i - 1]["bbox"].y1
            else:
                boundary_top = page_rect.y0

            # Find images between boundary_top and caption top
            relevant = [
                r for r in img_rects
                if r.y0 >= boundary_top - 10 and r.y1 <= cap_rect.y0 + 10
            ]

            if relevant:
                top = min(r.y0 for r in relevant) - 4
            else:
                top = max(boundary_top, cap_rect.y0 - 300)

            top = max(page_rect.y0, top)
            bottom = max(top + 20, bottom)

            clip = fitz.Rect(page_rect.x0, top, page_rect.x1, bottom)
            clip = clip & page_rect  # intersect with page to keep in bounds
            if clip.is_empty or clip.width < 10 or clip.height < 10:
                seen_nums.discard(fig_num)
                continue

            try:
                pix = page.get_pixmap(matrix=mat, clip=clip)
            except Exception:
                seen_nums.discard(fig_num)
                continue

            fig_id = f"fig_{fig_num}"
            fig_path = figures_dir / f"{fig_id}.png"
            try:
                pix.save(str(fig_path))
            except Exception:
                seen_nums.discard(fig_num)
                continue

            if fig_path.stat().st_size < MIN_FIGURE_PNG_BYTES:
                fig_path.unlink(missing_ok=True)
                seen_nums.discard(fig_num)
                continue

            figures.append(
                FigureInfo(
                    id=fig_id,
                    url=f"/api/papers/{paper_dir.name}/figures/{fig_id}",
                    caption=cap["text"],
                    page=page_num,
                )
            )

    figures.sort(key=lambda f: int(f.id.split("_")[1]))
    return figures


def extract_raw_text(doc: fitz.Document) -> str:
    """Dump all text from the PDF page-by-page into one string."""
    pages: list[str] = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        if text.strip():
            pages.append(text.strip())

    return "\n\n".join(pages)


def extract_pdf(pdf_path: Path, paper_id: str) -> RawExtraction:
    """Extract raw text + complete figures from a PDF."""
    paper_dir = settings.papers_dir / paper_id
    paper_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(pdf_path))
    raw_text = extract_raw_text(doc)
    figures = extract_figures(doc, paper_dir)
    doc.close()

    return RawExtraction(raw_text=raw_text, figures=figures)


def save_paper(paper: ParsedPaper, user_id: str | None = None) -> None:
    """Persist a ParsedPaper to disk as paper.json, and optionally to Supabase."""
    paper_dir = settings.papers_dir / paper.id
    paper_dir.mkdir(parents=True, exist_ok=True)
    meta_path = paper_dir / "paper.json"
    meta_path.write_text(paper.model_dump_json(indent=2))

    if user_id:
        from .db import save_paper_meta
        save_paper_meta(paper.model_dump(), user_id)


def get_paper(paper_id: str, user_id: str | None = None) -> ParsedPaper | None:
    """Load a previously parsed paper by ID (from disk, with Supabase cache fallback)."""
    meta_path = settings.papers_dir / paper_id / "paper.json"
    if not meta_path.exists():
        return None
    data = json.loads(meta_path.read_text())
    paper = ParsedPaper(**data)

    if user_id and not paper.cached_analysis:
        from .db import get_cached_analysis
        supabase_cache = get_cached_analysis(paper_id, user_id)
        if supabase_cache:
            paper.cached_analysis = supabase_cache
            meta_path.write_text(paper.model_dump_json(indent=2))

    return paper


def get_figure_path(paper_id: str, fig_id: str) -> Path | None:
    """Get the filesystem path for a figure image."""
    fig_path = settings.papers_dir / paper_id / "figures" / f"{fig_id}.png"
    if fig_path.exists():
        return fig_path
    return None


def list_papers(user_id: str | None = None) -> list[dict]:
    """List all parsed papers. When user_id is given and Supabase is configured, scope by user."""
    if user_id:
        from .db import list_papers_meta, get_db
        if get_db():
            return list_papers_meta(user_id)

    results = []
    for paper_dir in settings.papers_dir.iterdir():
        if not paper_dir.is_dir():
            continue
        meta_path = paper_dir / "paper.json"
        if meta_path.exists():
            data = json.loads(meta_path.read_text())
            results.append({
                "id": data["id"],
                "title": data["title"],
                "folder": data.get("folder", ""),
                "tags": data.get("tags", []),
                "authors": data.get("authors", []),
                "notes_count": len(data.get("notes", [])),
            })
    return results
