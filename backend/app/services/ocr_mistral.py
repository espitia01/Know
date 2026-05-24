"""Mistral OCR — PDF → Markdown + extracted images."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..config import settings
from ..models.schemas import OcrImage
from .ocr_cleanup import clean_ocr_markdown

logger = logging.getLogger(__name__)

MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr"
MISTRAL_OCR_MODEL = "mistral-ocr-latest"
MAX_OCR_PAGES = 500
_OCR_PANEL_ID_RE = re.compile(r"^p\d+-img-\d+\.png$")
_OCR_COMPOSITE_ID_RE = re.compile(r"^fig-\d+\.png$")
_PANEL_IMG_MD_RE = re.compile(r"!\[[^\]]*\]\((p\d+-img-\d+\.png)\)")
_BARE_PANEL_RE = re.compile(r"^(p\d+-img-\d+\.png)\s*$")
_CAPTION_START_RE = re.compile(r"^(Fig\.?\s+\d+\.|Figure\s+\d+\.)", re.IGNORECASE)
_FIG_CAP_MD_RE = re.compile(
    r"^(Fig\.?\s+\d+[.:][^\n]*|Figure\s+\d+[.:][^\n]*)",
    re.IGNORECASE | re.MULTILINE,
)
_COMPOSITE_BBOX_PAD_PX = 12

FRONT_MATTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "authors", "affiliations"],
    "properties": {
        "title": {"type": "string"},
        "venue": {
            "type": "string",
            "description": "Journal/conference name and year, if visible.",
        },
        "doi": {"type": "string"},
        "authors": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name"],
                "properties": {
                    "name": {"type": "string"},
                    "superscripts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Affiliation/footnote markers next to the name.",
                    },
                    "corresponding": {"type": "boolean"},
                    "email": {"type": "string"},
                },
            },
        },
        "affiliations": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text"],
                "properties": {
                    "tag": {
                        "type": "string",
                        "description": "Superscript marker e.g. '1' or '†'.",
                    },
                    "text": {"type": "string"},
                },
            },
        },
        "abstract": {
            "type": "string",
            "description": "Plain text. Math kept as $...$ inline.",
        },
    },
}


class MistralOcrUnavailable(Exception):
    """Raised when the Mistral API key is not configured."""


@dataclass
class FigureGroup:
    figure_id: str
    page: int
    caption: str
    panel_image_ids: list[str]
    bbox: tuple[float, float, float, float] | None
    dpi: int = 200


@dataclass
class OcrResult:
    markdown: str
    page_markdown: list[str]
    images: list[OcrImage] = field(default_factory=list)
    model: str = MISTRAL_OCR_MODEL
    front_matter: dict[str, Any] | None = None


def _api_key() -> str:
    key = (settings.mistral_api_key or "").strip()
    if not key:
        raise MistralOcrUnavailable("MISTRAL_API_KEY not configured")
    return key


def _decode_image_bytes(raw: str) -> bytes:
    payload = raw.strip()
    if payload.startswith("data:"):
        payload = payload.split(",", 1)[-1]
    try:
        return base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise RuntimeError("invalid_image_base64") from exc


def _parse_front_matter(raw: Any) -> dict[str, Any] | None:
    """Validate Mistral document_annotation against FRONT_MATTER_SCHEMA shape."""
    if raw is None:
        return None
    data: Any = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("front_matter JSON parse failed")
            return None
    if not isinstance(data, dict):
        return None
    title = data.get("title")
    authors = data.get("authors")
    affiliations = data.get("affiliations")
    if not isinstance(title, str) or not title.strip():
        return None
    if not isinstance(authors, list) or not isinstance(affiliations, list):
        return None
    return data


def _infer_image_caption(page_md: str, image_id: str) -> str:
    """Pull 'Figure N: …' caption lines that follow an OCR image reference."""
    lines = page_md.splitlines()
    for i, line in enumerate(lines):
        if image_id not in line:
            continue
        for j in range(i + 1, min(i + 4, len(lines))):
            candidate = lines[j].strip()
            if re.match(r"^(Figure|Fig\.?)\s", candidate, re.IGNORECASE):
                return candidate[:500]
        break
    return ""


def _rewrite_image_refs(markdown: str, mapping: dict[str, str]) -> str:
    """Map Mistral image ids (e.g. img-0.jpeg) to stable per-paper paths."""
    if not mapping:
        return markdown
    out = markdown
    # Longest ids first — avoids partial matches (img-1 vs img-10).
    for old_id, new_id in sorted(mapping.items(), key=lambda kv: len(kv[0]), reverse=True):
        out = out.replace(f"](./{old_id})", f"]({new_id})")
        out = out.replace(f"]({old_id})", f"]({new_id})")
        # Mistral sometimes emits a bare filename before the caption, not a markdown link.
        out = re.sub(
            rf"^{re.escape(old_id)}\s*\n",
            f"![figure]({new_id})\n",
            out,
            flags=re.MULTILINE,
        )
    return out


def _union_panel_bbox(
    panel_ids: list[str],
    panels_by_id: dict[str, OcrImage],
    pad: float = _COMPOSITE_BBOX_PAD_PX,
) -> tuple[float, float, float, float] | None:
    xs0: list[float] = []
    ys0: list[float] = []
    xs1: list[float] = []
    ys1: list[float] = []
    for pid in panel_ids:
        entry = panels_by_id.get(pid)
        if not entry or not entry.bbox or len(entry.bbox) != 4:
            continue
        x0, y0, x1, y1 = entry.bbox
        xs0.append(float(x0))
        ys0.append(float(y0))
        xs1.append(float(x1))
        ys1.append(float(y1))
    if not xs0:
        return None
    return (
        max(0.0, min(xs0) - pad),
        max(0.0, min(ys0) - pad),
        max(xs1) + pad,
        max(ys1) + pad,
    )


def group_panels_into_figures(
    page_index: int,
    page_markdown: str,
    panels_by_id: dict[str, OcrImage],
    figure_counter: list[int],
    dpi: int = 200,
) -> tuple[str, list[FigureGroup]]:
    """Cluster consecutive panel image refs before a Fig. N caption into one figure group."""
    lines = page_markdown.splitlines()
    out_lines: list[str] = []
    pending_panel_ids: list[str] = []
    groups: list[FigureGroup] = []
    i = 0

    def flush_orphan_panels() -> None:
        nonlocal pending_panel_ids
        if not pending_panel_ids:
            return
        fig_num = figure_counter[0]
        figure_counter[0] += 1
        figure_id = f"fig-{fig_num}.png"
        groups.append(
            FigureGroup(
                figure_id=figure_id,
                page=page_index,
                caption="",
                panel_image_ids=list(pending_panel_ids),
                bbox=_union_panel_bbox(pending_panel_ids, panels_by_id),
                dpi=dpi,
            ),
        )
        out_lines.append(f"![figure]({figure_id})")
        pending_panel_ids = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        panel_from_md = _PANEL_IMG_MD_RE.fullmatch(stripped)
        bare_panel = _BARE_PANEL_RE.match(stripped)
        if panel_from_md:
            pending_panel_ids.append(panel_from_md.group(1))
            i += 1
            continue
        if bare_panel:
            pending_panel_ids.append(bare_panel.group(1))
            i += 1
            continue

        if _CAPTION_START_RE.match(stripped) and pending_panel_ids:
            fig_num = figure_counter[0]
            figure_counter[0] += 1
            figure_id = f"fig-{fig_num}.png"
            caption = stripped
            groups.append(
                FigureGroup(
                    figure_id=figure_id,
                    page=page_index,
                    caption=caption,
                    panel_image_ids=list(pending_panel_ids),
                    bbox=_union_panel_bbox(pending_panel_ids, panels_by_id),
                    dpi=dpi,
                ),
            )
            out_lines.append(f"![figure]({figure_id})")
            out_lines.append(line)
            pending_panel_ids = []
            i += 1
            continue

        if pending_panel_ids and stripped and not _PANEL_IMG_MD_RE.search(line):
            flush_orphan_panels()

        out_lines.append(line)
        i += 1

    if pending_panel_ids:
        flush_orphan_panels()

    return "\n".join(out_lines), groups


def render_composite_from_pdf(
    pdf_bytes: bytes,
    fig: FigureGroup,
) -> bytes | None:
    """Clip the source PDF to the union bbox of OCR panels."""
    if not fig.bbox:
        return None
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        if fig.page < 0 or fig.page >= len(doc):
            doc.close()
            return None
        page = doc[fig.page]
        x0, y0, x1, y1 = fig.bbox
        scale = 72.0 / max(fig.dpi, 1)
        rect = fitz.Rect(x0 * scale, y0 * scale, x1 * scale, y1 * scale)
        pix = page.get_pixmap(clip=rect, dpi=200)
        data = pix.tobytes("png")
        doc.close()
        return data
    except Exception:
        logger.warning(
            "Composite figure render failed for %s page %s",
            fig.figure_id,
            fig.page,
            exc_info=True,
        )
        return None


def apply_composite_figures(
    pdf_bytes: bytes,
    paper_id: str,
    user_id: str | None,
    page_markdown: list[str],
    manifest: list[OcrImage],
    page_meta: list[tuple[int, int]],
) -> tuple[list[str], list[OcrImage]]:
    """Group OCR panel crops into composite figures rendered from the source PDF."""
    panels_by_id = {img.id: img for img in manifest}
    for img in manifest:
        if not img.kind:
            img.kind = "panel"

    figure_counter = [1]
    new_pages: list[str] = []
    composite_manifest: list[OcrImage] = []
    pending_composites: list[tuple[str, bytes]] = []

    for idx, md in enumerate(page_markdown):
        page_index, dpi = page_meta[idx] if idx < len(page_meta) else (idx, 200)
        rewritten, groups = group_panels_into_figures(
            page_index,
            md,
            panels_by_id,
            figure_counter,
            dpi=dpi,
        )

        page_composites: list[OcrImage] = []
        page_pending: list[tuple[str, bytes]] = []
        page_all_rendered = bool(groups)

        for group in groups:
            png = render_composite_from_pdf(pdf_bytes, group)
            if not png:
                page_all_rendered = False
                logger.warning(
                    "composite render failed paper_id=%s page=%s figure_id=%s panel_ids=%s",
                    paper_id,
                    page_index,
                    group.figure_id,
                    group.panel_image_ids,
                )
                continue
            page_pending.append((group.figure_id, png))
            page_composites.append(
                OcrImage(
                    id=group.figure_id,
                    page=group.page,
                    bbox=list(group.bbox) if group.bbox else None,
                    caption=group.caption,
                    kind="figure",
                    panel_ids=list(group.panel_image_ids),
                ),
            )

        if groups and page_all_rendered:
            new_pages.append(rewritten)
            composite_manifest.extend(page_composites)
            pending_composites.extend(page_pending)
        else:
            new_pages.append(md)

    if pending_composites:
        _persist_ocr_images(paper_id, user_id, pending_composites)

    if composite_manifest:
        return new_pages, composite_manifest + [img for img in manifest if img.kind == "panel"]

    return page_markdown, manifest


def recomposite_figures_for_paper(
    pdf_bytes: bytes,
    paper_id: str,
    user_id: str | None,
    page_markdown: list[str],
    manifest: list[OcrImage],
) -> tuple[list[str], list[OcrImage]]:
    """Re-run compositing from cached markdown (no Mistral API call)."""
    page_meta: list[tuple[int, int]] = []
    for i, md in enumerate(page_markdown):
        match = re.search(r"p(\d+)-img", md)
        page_index = int(match.group(1)) if match else i
        page_meta.append((page_index, 200))

    panel_manifest = [
        OcrImage(
            id=img.id,
            page=img.page,
            bbox=img.bbox,
            caption=img.caption or "",
            kind="panel",
            panel_ids=img.panel_ids,
        )
        for img in manifest
        if _OCR_PANEL_ID_RE.match(img.id)
    ]
    if not panel_manifest:
        return page_markdown, manifest

    return apply_composite_figures(
        pdf_bytes,
        paper_id,
        user_id,
        page_markdown,
        panel_manifest,
        page_meta,
    )


def _persist_ocr_images(
    paper_id: str,
    user_id: str | None,
    images: list[tuple[str, bytes]],
) -> None:
    if not images:
        return
    ocr_dir = settings.papers_dir / paper_id / "ocr"
    ocr_dir.mkdir(parents=True, exist_ok=True)
    for image_id, data in images:
        (ocr_dir / image_id).write_bytes(data)

    if not user_id:
        return
    from . import storage as cloud_storage

    for image_id, data in images:
        try:
            cloud_storage.upload_file(
                user_id,
                f"{paper_id}/ocr/{image_id}",
                data,
                "image/png",
            )
        except Exception:
            logger.warning(
                "OCR image cloud mirror failed for %s/%s",
                paper_id,
                image_id,
                exc_info=True,
            )


async def run_mistral_ocr(
    pdf_bytes: bytes,
    paper_id: str,
    user_id: str | None = None,
) -> OcrResult:
    """Run Mistral OCR on a PDF and persist extracted images."""
    api_key = _api_key()
    encoded = base64.b64encode(pdf_bytes).decode("ascii")

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            MISTRAL_OCR_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": MISTRAL_OCR_MODEL,
                "document": {
                    "type": "document_url",
                    "document_url": f"data:application/pdf;base64,{encoded}",
                },
                "include_image_base64": True,
                "image_limit": 200,
                "image_min_size": 80,
                "document_annotation_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "PaperFrontMatter",
                        "schema": FRONT_MATTER_SCHEMA,
                        "strict": True,
                    },
                },
            },
        )

    if resp.status_code != 200:
        detail = (resp.text or "")[:500]
        raise RuntimeError(f"mistral_ocr_failed:{resp.status_code}:{detail}")

    data = resp.json()
    front_matter = _parse_front_matter(data.get("document_annotation"))
    pages_raw = data.get("pages") or []
    if not isinstance(pages_raw, list) or not pages_raw:
        raise RuntimeError("mistral_ocr_empty_response")

    pages = sorted(
        (p for p in pages_raw if isinstance(p, dict)),
        key=lambda p: int(p.get("index", 0)),
    )
    if len(pages_raw) > MAX_OCR_PAGES:
        logger.warning(
            "Mistral OCR returned %s pages; truncating to %s for %s",
            len(pages_raw),
            MAX_OCR_PAGES,
            paper_id,
        )

    page_limit = min(len(pages), MAX_OCR_PAGES)
    page_markdown: list[str] = []
    page_meta: list[tuple[int, int]] = []
    manifest: list[OcrImage] = []
    pending_images: list[tuple[str, bytes]] = []

    for page in pages[:page_limit]:
        if not isinstance(page, dict):
            continue
        page_index = int(page.get("index", len(page_markdown)))
        dims = page.get("dimensions") if isinstance(page.get("dimensions"), dict) else {}
        dpi = int(dims.get("dpi") or 200) if dims else 200
        page_meta.append((page_index, dpi))
        md = str(page.get("markdown") or "")
        images = page.get("images") or []
        id_map: dict[str, str] = {}

        if isinstance(images, list):
            for img_idx, img in enumerate(images):
                if not isinstance(img, dict):
                    continue
                old_id = str(img.get("id") or f"img-{img_idx}.png")
                new_id = f"p{page_index}-img-{img_idx}.png"
                id_map[old_id] = new_id

                bbox = None
                try:
                    x0 = float(img.get("top_left_x", 0))
                    y0 = float(img.get("top_left_y", 0))
                    x1 = float(img.get("bottom_right_x", 0))
                    y1 = float(img.get("bottom_right_y", 0))
                    if x1 > x0 and y1 > y0:
                        bbox = [x0, y0, x1, y1]
                except (TypeError, ValueError):
                    bbox = None

                raw_b64 = img.get("image_base64")
                if isinstance(raw_b64, str) and raw_b64.strip():
                    pending_images.append((new_id, _decode_image_bytes(raw_b64)))

                manifest.append(
                    OcrImage(id=new_id, page=page_index, bbox=bbox, kind="panel"),
                )

        rewritten = _rewrite_image_refs(md, id_map)
        page_markdown.append(rewritten)
        for entry in manifest:
            if entry.page == page_index and not entry.caption:
                cap = _infer_image_caption(rewritten, entry.id)
                if cap:
                    entry.caption = cap

    _persist_ocr_images(paper_id, user_id, pending_images)

    page_markdown, manifest = apply_composite_figures(
        pdf_bytes,
        paper_id,
        user_id,
        page_markdown,
        manifest,
        page_meta,
    )

    page_markdown, joined = clean_ocr_markdown(page_markdown, manifest)
    if not joined.strip():
        raise RuntimeError("mistral_ocr_empty_markdown")

    model = str(data.get("model") or MISTRAL_OCR_MODEL)
    return OcrResult(
        markdown=joined,
        page_markdown=page_markdown,
        images=manifest,
        model=model,
        front_matter=front_matter,
    )


def validate_ocr_image_id(image_id: str) -> str:
    if _OCR_PANEL_ID_RE.match(image_id or "") or _OCR_COMPOSITE_ID_RE.match(image_id or ""):
        return image_id
    raise ValueError("invalid image_id")


def is_ocr_image_id(image_id: str) -> bool:
    return bool(_OCR_PANEL_ID_RE.match(image_id or "") or _OCR_COMPOSITE_ID_RE.match(image_id or ""))
