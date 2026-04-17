"""PDF parsing service using PyMuPDF (fitz)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import fitz  # pymupdf

from ..config import settings
from ..models.schemas import FigureInfo, ParsedPaper


@dataclass
class RawExtraction:
    raw_text: str
    figures: list[FigureInfo] = field(default_factory=list)


MIN_FIGURE_BYTES = 50_000


def extract_images(doc: fitz.Document, paper_dir: Path) -> list[FigureInfo]:
    """Extract images from the PDF, save to disk, return flat list of figures.
    Skips small images (logos, badges, icons) below MIN_FIGURE_BYTES."""
    figures_dir = paper_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)

    figures: list[FigureInfo] = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        image_list = page.get_images(full=True)

        for img_idx, img in enumerate(image_list):
            xref = img[0]
            try:
                pix = fitz.Pixmap(doc, xref)
            except Exception:
                continue

            if pix.n > 4:
                pix = fitz.Pixmap(fitz.csRGB, pix)

            fig_id = f"fig_p{page_num}_{img_idx}"
            fig_path = figures_dir / f"{fig_id}.png"
            pix.save(str(fig_path))

            if fig_path.stat().st_size < MIN_FIGURE_BYTES:
                fig_path.unlink(missing_ok=True)
                continue

            figures.append(
                FigureInfo(
                    id=fig_id,
                    url=f"/api/papers/{paper_dir.name}/figures/{fig_id}",
                    caption="",
                    page=page_num,
                )
            )

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
    """Extract raw text + images from a PDF. No heuristics, no classification."""
    paper_dir = settings.papers_dir / paper_id
    paper_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(pdf_path))
    raw_text = extract_raw_text(doc)
    figures = extract_images(doc, paper_dir)
    doc.close()

    return RawExtraction(raw_text=raw_text, figures=figures)


def save_paper(paper: ParsedPaper) -> None:
    """Persist a ParsedPaper to disk as paper.json."""
    paper_dir = settings.papers_dir / paper.id
    paper_dir.mkdir(parents=True, exist_ok=True)
    meta_path = paper_dir / "paper.json"
    meta_path.write_text(paper.model_dump_json(indent=2))


def get_paper(paper_id: str) -> ParsedPaper | None:
    """Load a previously parsed paper by ID."""
    meta_path = settings.papers_dir / paper_id / "paper.json"
    if not meta_path.exists():
        return None
    data = json.loads(meta_path.read_text())
    return ParsedPaper(**data)


def get_figure_path(paper_id: str, fig_id: str) -> Path | None:
    """Get the filesystem path for a figure image."""
    fig_path = settings.papers_dir / paper_id / "figures" / f"{fig_id}.png"
    if fig_path.exists():
        return fig_path
    return None


def list_papers() -> list[dict]:
    """List all parsed papers."""
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
