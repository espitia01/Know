"""PDF parsing service using PyMuPDF (fitz)."""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

import fitz  # pymupdf

from ..config import settings
from ..models.schemas import FigureInfo, ParsedPaper

logger = logging.getLogger(__name__)

# Hard caps on adversarial / pathological PDFs. A 50 MB PDF can still contain
# tens of thousands of pages, thousands of embedded images, or giant
# individual pages that blow up under pixmap rendering. These caps bound the
# worst case so a single bad upload can't pin a worker or exhaust memory.
MAX_PAGES = 500
MAX_FIGURES_PER_PAPER = 80
MAX_PIXMAP_PIXELS = 6_000_000  # ~4k × 1.5k cap on rendered figure size

# Cap on `cached_analysis[key]` list growth. Without a bound, a user running
# "explain" on every selection for a long paper could accumulate hundreds of
# entries in the JSONB blob, eventually making reads slow and the row huge.
# Keeping only the most recent N entries preserves recency without ever
# growing unbounded.
MAX_CACHED_ITEMS = 50


def append_capped(paper_cache: dict, key: str, item, limit: int = MAX_CACHED_ITEMS) -> list:
    """Append ``item`` to ``paper_cache[key]`` and trim to the last ``limit``
    entries. Returns the (now capped) list so callers can continue to use it.
    """
    existing = paper_cache.get(key) or []
    if not isinstance(existing, list):
        existing = []
    existing.append(item)
    if len(existing) > limit:
        existing = existing[-limit:]
    paper_cache[key] = existing
    return existing

_paper_locks: dict[str, threading.Lock] = {}
_locks_lock = threading.Lock()


def _get_paper_lock(paper_id: str) -> threading.Lock:
    with _locks_lock:
        if paper_id not in _paper_locks:
            _paper_locks[paper_id] = threading.Lock()
        return _paper_locks[paper_id]


def _forget_paper_lock(paper_id: str) -> None:
    """Drop the lock for a paper that no longer exists. Prevents the lock
    registry from growing unbounded over a worker's lifetime."""
    with _locks_lock:
        _paper_locks.pop(paper_id, None)


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


def _safe_pixmap(page: fitz.Page, mat: fitz.Matrix, clip: fitz.Rect) -> fitz.Pixmap | None:
    """Render a clip, downscaling the matrix if the result would exceed the
    pixel cap. Prevents adversarial pages from allocating huge buffers."""
    approx = clip.width * clip.height * (mat.a * mat.d)
    scale = 1.0
    if approx > MAX_PIXMAP_PIXELS:
        scale = (MAX_PIXMAP_PIXELS / approx) ** 0.5
        mat = fitz.Matrix(mat.a * scale, mat.d * scale)
    try:
        return page.get_pixmap(matrix=mat, clip=clip)
    except Exception:
        return None


def extract_figures(doc: fitz.Document, paper_dir: Path) -> list[FigureInfo]:
    """Extract whole figures by detecting captions and rendering page regions.

    Instead of pulling individual embedded images (which splits composite
    figures), this finds "Figure N" / "Fig. N" captions, determines the
    bounding region of the complete figure, and renders that page clip as
    a single PNG. Page count and total figure output are bounded to protect
    against adversarial PDFs.
    """
    figures_dir = paper_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)

    figures: list[FigureInfo] = []
    seen_nums: set[int] = set()
    mat = fitz.Matrix(RENDER_SCALE, RENDER_SCALE)
    page_limit = min(len(doc), MAX_PAGES)

    for page_num in range(page_limit):
        if len(figures) >= MAX_FIGURES_PER_PAPER:
            break
        page = doc[page_num]
        captions = _find_caption_blocks(page)
        if not captions:
            continue

        img_rects = _image_rects_on_page(page)
        page_rect = page.rect

        for i, cap in enumerate(captions):
            if len(figures) >= MAX_FIGURES_PER_PAPER:
                break
            fig_num = cap["num"]
            if fig_num in seen_nums:
                continue
            seen_nums.add(fig_num)

            cap_rect = cap["bbox"]
            bottom = min(cap_rect.y1 + 4, page_rect.y1)

            if i > 0:
                boundary_top = captions[i - 1]["bbox"].y1
            else:
                boundary_top = page_rect.y0

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
            clip = clip & page_rect
            if clip.is_empty or clip.width < 10 or clip.height < 10:
                seen_nums.discard(fig_num)
                continue

            pix = _safe_pixmap(page, mat, clip)
            if pix is None:
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
    if len(doc) > MAX_PAGES:
        logger.info(
            "Truncated figure extraction at %d/%d pages for %s",
            MAX_PAGES, len(doc), paper_dir.name,
        )
    return figures


def extract_raw_text(doc: fitz.Document) -> str:
    """Dump all text from the PDF page-by-page into one string, bounded to
    ``MAX_PAGES`` pages so adversarial PDFs can't pin a worker."""
    pages: list[str] = []
    page_limit = min(len(doc), MAX_PAGES)

    for page_num in range(page_limit):
        page = doc[page_num]
        text = page.get_text("text")
        if text.strip():
            pages.append(text.strip())

    if len(doc) > MAX_PAGES:
        logger.info("Truncated text extraction at %d/%d pages", MAX_PAGES, len(doc))
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
    """Persist a ParsedPaper to disk as paper.json, and optionally to Supabase.

    Prefer ``mutate_paper`` when you need to update a ParsedPaper that already
    exists on disk. Calling ``save_paper`` directly on a locally-modified
    ParsedPaper is racy: two concurrent requests (e.g. two streaming
    summaries finishing around the same time) can each load the paper,
    append different cached_analysis entries, and stomp each other's writes.
    ``mutate_paper`` holds the per-paper lock across load + mutate + save.
    """
    paper_dir = settings.papers_dir / paper.id
    paper_dir.mkdir(parents=True, exist_ok=True)
    meta_path = paper_dir / "paper.json"
    with _get_paper_lock(paper.id):
        meta_path.write_text(paper.model_dump_json(indent=2))

    if user_id:
        from .db import save_paper_meta
        save_paper_meta(paper.model_dump(), user_id)


def mutate_paper(
    paper_id: str, user_id: str, mutator,
) -> ParsedPaper:
    """Load → mutate → save a paper under the per-paper lock.

    ``mutator`` is a callable that receives the current ``ParsedPaper`` and
    mutates it in place (or returns a new one). The whole load-mutate-save
    cycle runs under ``_get_paper_lock(paper_id)`` so parallel analysis
    routes writing different ``cached_analysis`` keys no longer lose each
    other's updates. This is the C1 fix from the backend audit.

    Raises ``FileNotFoundError`` if the paper doesn't exist.
    """
    lock = _get_paper_lock(paper_id)
    with lock:
        paper = _load_paper_locked(paper_id, user_id)
        if paper is None:
            raise FileNotFoundError(paper_id)
        result = mutator(paper)
        if isinstance(result, ParsedPaper):
            paper = result
        meta_path = settings.papers_dir / paper.id / "paper.json"
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(paper.model_dump_json(indent=2))

    # DB persistence is best done outside the per-paper filesystem lock
    # because it issues a network call, but before the caller observes the
    # returned ParsedPaper, so readers don't see a stale DB copy.
    from .db import save_paper_meta
    save_paper_meta(paper.model_dump(), user_id)
    return paper


def _load_paper_locked(paper_id: str, user_id: str | None) -> ParsedPaper | None:
    """Read paper.json (and rehydrate from Supabase if missing). Assumes the
    caller already holds ``_get_paper_lock(paper_id)``."""
    meta_path = settings.papers_dir / paper_id / "paper.json"
    if meta_path.exists():
        data = json.loads(meta_path.read_text())
        paper = ParsedPaper(**data)
        if user_id and not paper.cached_analysis:
            from .db import get_cached_analysis
            supabase_cache = get_cached_analysis(paper_id, user_id)
            if supabase_cache:
                paper.cached_analysis = supabase_cache
                meta_path.write_text(paper.model_dump_json(indent=2))
        return paper

    if user_id:
        from .db import get_paper_meta
        row = get_paper_meta(paper_id, user_id)
        if row:
            paper = ParsedPaper(
                id=row["id"],
                title=row.get("title", ""),
                authors=row.get("authors", []),
                raw_text=row.get("raw_text", ""),
                figures=[],
                folder=row.get("folder", ""),
                tags=row.get("tags", []),
                notes=row.get("notes", []),
                cached_analysis=row.get("cached_analysis", {}),
            )
            paper_dir = settings.papers_dir / paper_id
            paper_dir.mkdir(parents=True, exist_ok=True)
            meta_path.write_text(paper.model_dump_json(indent=2))
            return paper
    return None


def get_paper(paper_id: str, user_id: str | None = None) -> ParsedPaper | None:
    """Load a previously parsed paper by ID (from disk, with Supabase fallback)."""
    with _get_paper_lock(paper_id):
        return _load_paper_locked(paper_id, user_id)


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
        raise ValueError("Database unavailable")

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
