"""Tests for Mistral OCR service."""

from __future__ import annotations

import asyncio
import base64
from unittest.mock import AsyncMock, patch

import pytest

from app.services.ocr_mistral import (
    MistralOcrUnavailable,
    _parse_front_matter,
    _rewrite_image_refs,
    group_panels_into_figures,
    render_composite_from_pdf,
    FigureGroup,
    run_mistral_ocr,
)
from app.models.schemas import OcrImage


def test_rewrite_image_refs():
    md = "![fig](img-0.png) and ![other](./img-1.png)"
    out = _rewrite_image_refs(md, {"img-0.png": "p0-img-0.png", "img-1.png": "p0-img-1.png"})
    assert "p0-img-0.png" in out
    assert "p0-img-1.png" in out


def test_infer_image_caption():
    from app.services.ocr_mistral import _infer_image_caption

    md = "![figure](p0-img-0.png)\nFigure 2: Accuracy vs. epoch."
    assert _infer_image_caption(md, "p0-img-0.png") == "Figure 2: Accuracy vs. epoch."


def test_rewrite_image_refs_bare_filename():
    md = "img-0.jpeg\nFigure 1: Scatter plot."
    out = _rewrite_image_refs(md, {"img-0.jpeg": "p0-img-0.png"})
    assert out.startswith("![figure](p0-img-0.png)\nFigure 1:")


def test_run_mistral_ocr_persists_images(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.ocr_mistral.settings.papers_dir", tmp_path)
    monkeypatch.setattr("app.services.ocr_mistral.settings.mistral_api_key", "test-key")

    png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
    payload = {
        "model": "mistral-ocr-latest",
        "pages": [
            {
                "index": 1,
                "markdown": "Page two",
                "images": [],
            },
            {
                "index": 0,
                "markdown": "# Title\n\n![img](img-0.png)\nFig. 1. Test figure.",
                "images": [
                    {
                        "id": "img-0.png",
                        "top_left_x": 1,
                        "top_left_y": 2,
                        "bottom_right_x": 10,
                        "bottom_right_y": 20,
                        "image_base64": png,
                    }
                ],
            },
        ],
    }

    class FakeResp:
        status_code = 200

        def json(self):
            return payload

    async def _run():
        with patch("app.services.ocr_mistral.httpx.AsyncClient") as client_cls:
            client = AsyncMock()
            client.__aenter__.return_value = client
            client.post = AsyncMock(return_value=FakeResp())
            client_cls.return_value = client
            result = await run_mistral_ocr(b"%PDF-1.4 test", "paper123", "user1")
            call_json = client.post.call_args.kwargs["json"]
            assert call_json["document"]["type"] == "document_url"
            assert call_json["document"]["document_url"].startswith("data:application/pdf;base64,")
            assert "document_annotation_format" in call_json
            return result

    result = asyncio.run(_run())

    assert result.page_markdown[0].startswith("# Title")
    assert "p0-img-0.png" in result.page_markdown[0]
    assert result.page_markdown[1] == "Page two"
    assert result.images[0].id == "p0-img-0.png"
    assert (tmp_path / "paper123" / "ocr" / "p0-img-0.png").exists()


def test_run_mistral_ocr_missing_key():
    async def _run():
        with patch("app.services.ocr_mistral.settings.mistral_api_key", ""):
            with pytest.raises(MistralOcrUnavailable):
                await run_mistral_ocr(b"%PDF", "p1", None)

    asyncio.run(_run())


def test_group_panels_into_figures_groups_by_caption():
    md = (
        "![figure](p0-img-0.png)\n"
        "![figure](p0-img-1.png)\n"
        "Fig. 1. Composite panels A–D.\n"
        "\n"
        "Body text."
    )
    panels = {
        "p0-img-0.png": OcrImage(id="p0-img-0.png", page=0, bbox=[10, 20, 100, 120]),
        "p0-img-1.png": OcrImage(id="p0-img-1.png", page=0, bbox=[110, 20, 200, 120]),
    }
    counter = [1]
    out, groups = group_panels_into_figures(0, md, panels, counter)
    assert len(groups) == 1
    assert groups[0].figure_id == "fig-1.png"
    assert groups[0].panel_image_ids == ["p0-img-0.png", "p0-img-1.png"]
    assert groups[0].caption.startswith("Fig. 1.")
    assert "fig-1.png" in out
    assert "p0-img-0.png" not in out


def test_group_panels_into_figures_handles_orphan_panels():
    md = "![figure](p1-img-0.png)\n\nNo caption here."
    panels = {
        "p1-img-0.png": OcrImage(id="p1-img-0.png", page=1, bbox=[0, 0, 50, 50]),
    }
    counter = [1]
    out, groups = group_panels_into_figures(1, md, panels, counter)
    assert len(groups) == 1
    assert groups[0].caption == ""
    assert "fig-1.png" in out


def test_composite_render_falls_back_when_pdf_missing():
    group = FigureGroup(
        figure_id="fig-1.png",
        page=0,
        caption="Fig. 1.",
        panel_image_ids=["p0-img-0.png"],
        bbox=(0, 0, 100, 100),
        dpi=200,
    )
    assert render_composite_from_pdf(b"not-a-pdf", group) is None


def test_parse_front_matter_valid():
    raw = {
        "title": "Test Paper",
        "authors": [{"name": "Alice"}],
        "affiliations": [{"text": "MIT", "tag": "1"}],
        "abstract": "We test.",
    }
    assert _parse_front_matter(raw) == raw


def test_parse_front_matter_invalid():
    assert _parse_front_matter(None) is None
    assert _parse_front_matter({"title": "", "authors": [], "affiliations": []}) is None
    assert _parse_front_matter("not json") is None


def test_run_mistral_ocr_parses_front_matter(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.ocr_mistral.settings.papers_dir", tmp_path)
    monkeypatch.setattr("app.services.ocr_mistral.settings.mistral_api_key", "test-key")

    payload = {
        "model": "mistral-ocr-latest",
        "document_annotation": {
            "title": "Annotated Title",
            "authors": [{"name": "Alice", "superscripts": ["1"]}],
            "affiliations": [{"tag": "1", "text": "Berkeley"}],
        },
        "pages": [{"index": 0, "markdown": "# Annotated Title\n\nBody", "images": []}],
    }

    class FakeResp:
        status_code = 200

        def json(self):
            return payload

    async def _run():
        with patch("app.services.ocr_mistral.httpx.AsyncClient") as client_cls:
            client = AsyncMock()
            client.__aenter__.return_value = client
            client.post = AsyncMock(return_value=FakeResp())
            client_cls.return_value = client
            return await run_mistral_ocr(b"%PDF-1.4 test", "paper456", "user1")

    result = asyncio.run(_run())
    assert result.front_matter is not None
    assert result.front_matter["title"] == "Annotated Title"
