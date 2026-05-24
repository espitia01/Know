"""Tests for OCR markdown cleanup."""

from __future__ import annotations

import json
from pathlib import Path

from app.models.schemas import OcrImage
from app.services.ocr_cleanup import (
    clean_ocr_markdown,
    collapse_author_byline,
    collapse_fragmented_math_paragraphs,
    dedupe_inline_math_duplicates,
    drop_orphan_figure_refs,
    drop_panel_refs_when_composites_exist,
    strip_ocr_ascii_fallback,
    strip_page_number_footers,
    strip_running_headers_footers,
    wrap_byline_paragraph,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_strip_running_headers_footers():
    pages = [
        "VOLUME 90 HEADER\n\n# Title\n\nBody A",
        "VOLUME 90 HEADER\n\nMore body",
        "VOLUME 90 HEADER\n\nEven more",
    ]
    out = strip_running_headers_footers(pages)
    assert "VOLUME 90 HEADER" not in "\n".join(out)
    assert "# Title" in out[0]


def test_strip_page_number_footers():
    md = "076401-1 076401-1\n\n076401-1 0031-9007/03/90(7)/076401(4)$20.00 © 2003 The American Physical Society 076401-1\n\nKeep me"
    out = strip_page_number_footers(md)
    assert "Keep me" in out
    assert "076401-1 076401-1" not in out
    assert "Physical Society" not in out


def test_strip_ocr_ascii_fallback():
    md = "Intro\n\nν\nc\n(\nr̂\n\n$$\\nu_c(\\hat r) = 1.$$"
    out = strip_ocr_ascii_fallback(md)
    assert "ν" not in out.split("$$")[0]
    assert "$$\\nu_c(\\hat r) = 1.$$" in out


def test_dedupe_inline_math_duplicates():
    md = "reaching $52.7\\%$ 52.7% of the peak"
    out = dedupe_inline_math_duplicates(md)
    assert "52.7% of the peak" not in out
    assert "$52.7\\%$" in out


def test_collapse_fragmented_math_paragraphs():
    md = "$a$\n\n$b$\n\n$c$\n\nNormal text"
    out = collapse_fragmented_math_paragraphs(md)
    assert "$a$ $b$ $c$" in out


def test_collapse_author_byline():
    md = "# Title\n\nAlice\n1\n,\n2\n1,2\n, Bob\n3\n3\n\n## Abstract"
    out = collapse_author_byline(md)
    assert "Alice<sup>1,2</sup>" in out
    assert "1\n,\n2" not in out


def test_wrap_byline_paragraph():
    md = "# Title\n\nAlice<sup>1,2</sup>, Bob<sup>3</sup>\n\n## Abstract"
    out = wrap_byline_paragraph(md)
    assert '<p class="reader-byline">' in out


def test_drop_orphan_figure_refs():
    md = "![figure](orphan.png)\n\n![figure](good.png)\nFig. 1. Caption."
    out = drop_orphan_figure_refs(md)
    assert "orphan.png" not in out
    assert "good.png" in out


def test_drop_panel_refs_when_composites_exist():
    md = "![figure](fig-1.png)\n![figure](p0-img-0.png) A\nBody"
    out = drop_panel_refs_when_composites_exist(md)
    assert "fig-1.png" in out
    assert "p0-img-0.png" not in out


def test_clean_ocr_markdown_end_to_end():
    payload = json.loads((FIXTURES / "ocr_messy_payload.json").read_text())
    pages = [p["markdown"] for p in payload["pages"]]
    cleaned_pages, joined = clean_ocr_markdown(pages, [])

    all_text = joined
    assert "VOLUME 90" not in all_text
    assert "Physical Society" not in all_text
    assert "Alice<sup>" in all_text or "reader-byline" in all_text
    assert "$52.7\\%$" in all_text
    assert "52.7% of the peak" not in all_text
    assert "p0-img-2.png" not in all_text
    assert "fig-1.png" in all_text
    assert "Fig. 1." in all_text
    assert len(cleaned_pages) == 2

    # Glyph stack removed from page 0
    assert "ν\n\nc\n\n(" not in cleaned_pages[0]


def test_clean_ocr_markdown_preserves_page_count():
    pages = ["Page one", "Page two", "Page three"]
    cleaned, _ = clean_ocr_markdown(pages, [])
    assert len(cleaned) == 3


def test_clean_ocr_markdown_accepts_ocr_images_arg():
    images = [OcrImage(id="p0-img-0.png", page=0)]
    cleaned, joined = clean_ocr_markdown(["# Hi"], images)
    assert joined
