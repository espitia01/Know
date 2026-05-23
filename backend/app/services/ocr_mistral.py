"""Mistral OCR — PDF → Markdown + extracted images."""

from __future__ import annotations

import base64
import binascii
import logging
import re
from dataclasses import dataclass, field

import httpx

from ..config import settings
from ..models.schemas import OcrImage

logger = logging.getLogger(__name__)

MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr"
MISTRAL_OCR_MODEL = "mistral-ocr-latest"
MAX_OCR_PAGES = 500
_OCR_IMAGE_ID_RE = re.compile(r"^p\d+-img-\d+\.png$")


class MistralOcrUnavailable(Exception):
    """Raised when the Mistral API key is not configured."""


@dataclass
class OcrResult:
    markdown: str
    page_markdown: list[str]
    images: list[OcrImage] = field(default_factory=list)
    model: str = MISTRAL_OCR_MODEL


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
            },
        )

    if resp.status_code != 200:
        detail = (resp.text or "")[:500]
        raise RuntimeError(f"mistral_ocr_failed:{resp.status_code}:{detail}")

    data = resp.json()
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
    manifest: list[OcrImage] = []
    pending_images: list[tuple[str, bytes]] = []

    for page in pages[:page_limit]:
        if not isinstance(page, dict):
            continue
        page_index = int(page.get("index", len(page_markdown)))
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

                manifest.append(OcrImage(id=new_id, page=page_index, bbox=bbox))

        page_markdown.append(_rewrite_image_refs(md, id_map))

    _persist_ocr_images(paper_id, user_id, pending_images)

    joined = "\n\n---\n\n".join(page_markdown)
    if not joined.strip():
        raise RuntimeError("mistral_ocr_empty_markdown")

    model = str(data.get("model") or MISTRAL_OCR_MODEL)
    return OcrResult(
        markdown=joined,
        page_markdown=page_markdown,
        images=manifest,
        model=model,
    )


def validate_ocr_image_id(image_id: str) -> str:
    if not _OCR_IMAGE_ID_RE.match(image_id or ""):
        raise ValueError("invalid image_id")
    return image_id
