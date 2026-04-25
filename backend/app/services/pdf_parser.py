"""PDF parsing service using PyMuPDF (fitz)."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import OrderedDict
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
_paper_cache: "OrderedDict[tuple[str, str], tuple[float, ParsedPaper]]" = OrderedDict()
_paper_cache_lock = threading.Lock()
PAPER_CACHE_TTL_SECONDS = 60.0
PAPER_CACHE_MAX = 256


def _get_paper_lock(paper_id: str) -> threading.Lock:
    with _locks_lock:
        if paper_id not in _paper_locks:
            _paper_locks[paper_id] = threading.Lock()
        return _paper_locks[paper_id]


def _forget_paper_lock(paper_id: str) -> None:
    """Drop the lock for a paper that no longer exists. Prevents the lock
    registry from growing unbounded over a worker's lifetime."""
    invalidate_paper_cache(paper_id)
    with _locks_lock:
        _paper_locks.pop(paper_id, None)


def invalidate_paper_cache(paper_id: str, user_id: str | None = None) -> None:
    """Drop process-local cached ParsedPaper objects for a paper."""
    with _paper_cache_lock:
        for key in list(_paper_cache.keys()):
            if key[0] == paper_id and (user_id is None or key[1] == (user_id or "")):
                _paper_cache.pop(key, None)


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


def _detect_columns(page: fitz.Page) -> list[tuple[float, float]]:
    """Infer the horizontal extents of the text columns on this page.

    Many scientific papers use a two-column layout where figures are
    either confined to a single column or span both. The figure
    extractor previously took the full page width as the horizontal
    clip, which — for a single-column figure — pulled in the adjacent
    column's body text instead of just the figure.

    The heuristic here clusters the left edges (``x0``) of every text
    block on the page. If we see two well-separated clusters with a
    clear horizontal gap between them we report two column extents; in
    every other case we fall through to a single-column page, so
    narrow-column figures stay narrow and full-page figures stay
    full-width.

    Returns a list of ``(x0, x1)`` pairs in left-to-right order.
    """
    page_rect = page.rect
    fallback = [(page_rect.x0, page_rect.x1)]
    try:
        blocks = page.get_text("dict").get("blocks", [])
    except Exception:
        return fallback

    text_blocks = [b for b in blocks if b.get("type") == 0 and b.get("bbox")]
    # Require a few blocks to draw any meaningful conclusion — header /
    # cover pages shouldn't be treated as two-column by accident.
    if len(text_blocks) < 6:
        return fallback

    x0s = sorted(float(b["bbox"][0]) for b in text_blocks)
    # Column gutters in scientific layouts tend to be at least ~8% of
    # the page width. Anything smaller is much more likely to be a
    # paragraph indent or an inline float.
    gap_threshold = max(20.0, page_rect.width * 0.08)

    clusters: list[list[float]] = []
    current = [x0s[0]]
    for x in x0s[1:]:
        if x - current[-1] > gap_threshold:
            clusters.append(current)
            current = [x]
        else:
            current.append(x)
    clusters.append(current)

    if len(clusters) != 2:
        return fallback
    left_cluster, right_cluster = clusters

    # Each cluster must carry enough blocks to pass as a real column;
    # otherwise we're probably looking at an accidental split caused by
    # a caption or figure label that happens to sit far to the left.
    if len(left_cluster) < 3 or len(right_cluster) < 3:
        return fallback

    left_min = min(left_cluster)
    right_min = min(right_cluster)
    # Widen each column to the right edge of the widest block that
    # *starts* in it. This correctly bounds a column even when blocks
    # are ragged-right.
    def col_x1(cluster: list[float]) -> float:
        member = set(cluster)
        return max(
            (float(b["bbox"][2]) for b in text_blocks if float(b["bbox"][0]) in member),
            default=page_rect.x1,
        )

    left_x1 = col_x1(left_cluster)
    right_x1 = col_x1(right_cluster)

    # Reject degenerate layouts — the left column should actually be
    # left of the right one, with a positive gutter.
    if right_min <= left_x1 or right_min - left_x1 < 8:
        return fallback

    return [(left_min, left_x1), (right_min, right_x1)]


def _horizontal_extent_for_figure(
    cap_rect: fitz.Rect,
    relevant_imgs: list[fitz.Rect],
    cols: list[tuple[float, float]],
    page_rect: fitz.Rect,
) -> tuple[float, float]:
    """Decide the left/right edges of the clip for a single figure.

    - If the page is a single column, always return the full page width.
    - If the caption or any of the figure's images clearly span both
      columns (>= 70% of the page width or crossing the gutter), treat
      the figure as full-width.
    - Otherwise snap the clip to whichever column contains the caption
      (and the image rects, when present), so a column-confined figure
      doesn't drag its neighbour's body text into the crop.
    """
    if len(cols) < 2:
        return page_rect.x0, page_rect.x1

    (l_x0, l_x1), (r_x0, r_x1) = cols
    gutter = (l_x1 + r_x0) / 2

    def straddles_both_cols(rect: fitz.Rect) -> bool:
        return rect.x0 < l_x1 - 4 and rect.x1 > r_x0 + 4

    def width_ratio(rect: fitz.Rect) -> float:
        return rect.width / max(page_rect.width, 1.0)

    for r in [cap_rect, *relevant_imgs]:
        if straddles_both_cols(r) or width_ratio(r) >= 0.70:
            return page_rect.x0, page_rect.x1

    # Column-confined. Pick by caption centre first (captions sit under
    # their figure) and fall back to the image rects' centre of mass
    # if the caption is oddly placed.
    cap_mid = (cap_rect.x0 + cap_rect.x1) / 2
    if cap_mid <= gutter:
        col_x0, col_x1 = l_x0, l_x1
    else:
        col_x0, col_x1 = r_x0, r_x1

    # Pad a few points so we don't shave antialiased glyph edges off
    # the figure or the caption.
    return max(page_rect.x0, col_x0 - 4), min(page_rect.x1, col_x1 + 4)


def _find_figure_top_via_whitespace(
    page: fitz.Page,
    *,
    cap_rect: fitz.Rect,
    boundary_top: float,
    x0: float,
    x1: float,
) -> float | None:
    """Locate the top edge of a vector / unindexed figure by
    looking for the *first sufficiently tall vertical whitespace gap*
    above the caption, restricted to the column the figure sits in.

    Two-column papers are where this matters most: when no embedded
    image rects are present (TikZ, matplotlib output), the caller's
    fallback used to grab a flat 300-pt slab above the caption,
    which dragged the column's body text into the crop. Walking the
    text blocks in column-bounded order and stopping at the first
    big gap gives a much tighter top edge.

    Returns ``None`` when the heuristic can't find a clean break,
    leaving the caller to use its own fallback.
    """
    try:
        blocks = page.get_text("dict").get("blocks", [])
    except Exception:
        return None

    # Only consider text blocks that *overlap* the figure's column
    # horizontally. Caption-row blocks and items strictly above the
    # caption qualify; everything below the caption is irrelevant.
    column_blocks: list[fitz.Rect] = []
    for b in blocks:
        if b.get("type") != 0:
            continue
        bbox = b.get("bbox")
        if not bbox:
            continue
        rect = fitz.Rect(bbox)
        if rect.y1 >= cap_rect.y0 - 1:
            continue
        if rect.x1 < x0 - 2 or rect.x0 > x1 + 2:
            continue
        column_blocks.append(rect)

    if not column_blocks:
        # Nothing above the caption in this column — the figure
        # probably starts at `boundary_top` (top of the page or just
        # below the previous caption).
        return max(boundary_top, cap_rect.y0 - 240)

    # Walk top-to-bottom and find the largest vertical gap between
    # consecutive blocks; if that gap is "big" relative to the
    # caption's own height (figures consistently sit in a gap larger
    # than a paragraph break), the bottom of the gap is the figure's
    # top edge.
    column_blocks.sort(key=lambda r: r.y0)
    cap_h = max(8.0, cap_rect.height)
    min_gap = max(cap_h * 1.4, 18.0)

    figure_top = boundary_top
    for prev, nxt in zip(column_blocks, column_blocks[1:]):
        gap = nxt.y0 - prev.y1
        if gap >= min_gap and prev.y1 > figure_top:
            figure_top = prev.y1
    # Pad a few points above so we don't shave the first line of
    # vector graphics off (some figures start *exactly* on the first
    # white pixel).
    figure_top = max(boundary_top, figure_top - 4)
    if figure_top >= cap_rect.y0:
        return None
    return figure_top


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
        cols = _detect_columns(page)

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

            # Determine the horizontal extent of the figure first so we
            # can also filter `relevant` image rects to just the ones
            # that actually belong to this column. Otherwise a
            # neighbouring column's image above this caption would drag
            # `top` too high and pollute the crop.
            relevant_all = [
                r for r in img_rects
                if r.y0 >= boundary_top - 10 and r.y1 <= cap_rect.y0 + 10
            ]
            x0, x1 = _horizontal_extent_for_figure(cap_rect, relevant_all, cols, page_rect)

            relevant = [r for r in relevant_all if r.x0 >= x0 - 4 and r.x1 <= x1 + 4]
            if not relevant:
                # Fall back to the original (unrestricted) set so we
                # still have *something* to anchor the top edge to when
                # column restriction eliminated every candidate image.
                relevant = relevant_all

            if relevant:
                top = min(r.y0 for r in relevant) - 4
            else:
                # No embedded image rects in this column above the
                # caption — the figure is likely vector graphics
                # (PDFs generated from TikZ / matplotlib often hit
                # this path) or a collection of glyphs we can't index
                # by `get_images`. Fall back to a *whitespace* probe:
                # walk up from the caption looking for the first
                # vertical gap that's tall enough to bound a figure.
                # Two-column papers were the failure mode here —
                # using a flat 300-pt fallback dragged the column's
                # body text into the crop. Detecting whitespace
                # corrects that without ever exceeding `boundary_top`.
                top = _find_figure_top_via_whitespace(
                    page,
                    cap_rect=cap_rect,
                    boundary_top=boundary_top,
                    x0=x0,
                    x1=x1,
                ) or max(boundary_top, cap_rect.y0 - 300)

            top = max(page_rect.y0, top)
            bottom = max(top + 20, bottom)

            clip = fitz.Rect(x0, top, x1, bottom)
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
    invalidate_paper_cache(paper.id, user_id)

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
        invalidate_paper_cache(paper.id, user_id)

    # DB persistence is best done outside the per-paper filesystem lock
    # because it issues a network call, but before the caller observes the
    # returned ParsedPaper, so readers don't see a stale DB copy.
    from .db import save_paper_meta
    save_paper_meta(paper.model_dump(), user_id)
    return paper


def append_cached_analysis_local(
    paper_id: str, user_id: str, key: str, entry,
) -> None:
    """Mirror an atomic DB append into the local paper.json cache only."""
    lock = _get_paper_lock(paper_id)
    with lock:
        paper = _load_paper_locked(paper_id, user_id)
        if paper is None:
            return
        append_capped(paper.cached_analysis, key, entry)
        meta_path = settings.papers_dir / paper.id / "paper.json"
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(paper.model_dump_json(indent=2))
        invalidate_paper_cache(paper.id, user_id)


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
    cache_key = (paper_id, user_id or "")
    now = time.time()
    with _paper_cache_lock:
        cached = _paper_cache.get(cache_key)
        if cached and now - cached[0] < PAPER_CACHE_TTL_SECONDS:
            _paper_cache.move_to_end(cache_key)
            return cached[1].model_copy(deep=True)
        if cached:
            _paper_cache.pop(cache_key, None)
    with _get_paper_lock(paper_id):
        paper = _load_paper_locked(paper_id, user_id)
    if paper is not None:
        with _paper_cache_lock:
            _paper_cache[cache_key] = (now, paper.model_copy(deep=True))
            _paper_cache.move_to_end(cache_key)
            while len(_paper_cache) > PAPER_CACHE_MAX:
                _paper_cache.popitem(last=False)
        return paper.model_copy(deep=True)
    return None


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
