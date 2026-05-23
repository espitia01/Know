"""Tests for Mistral OCR service."""

from __future__ import annotations

import asyncio
import base64
from unittest.mock import AsyncMock, patch

import pytest

from app.services.ocr_mistral import (
    MistralOcrUnavailable,
    _rewrite_image_refs,
    run_mistral_ocr,
)


def test_rewrite_image_refs():
    md = "![fig](img-0.png) and ![other](./img-1.png)"
    out = _rewrite_image_refs(md, {"img-0.png": "p0-img-0.png", "img-1.png": "p0-img-1.png"})
    assert "p0-img-0.png" in out
    assert "p0-img-1.png" in out


def test_run_mistral_ocr_persists_images(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.ocr_mistral.settings.papers_dir", tmp_path)
    monkeypatch.setattr("app.services.ocr_mistral.settings.mistral_api_key", "test-key")

    png = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
    payload = {
        "model": "mistral-ocr-latest",
        "pages": [
            {
                "index": 0,
                "markdown": "# Title\n\n![img](img-0.png)",
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
            {
                "index": 1,
                "markdown": "Page two",
                "images": [],
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
            return await run_mistral_ocr(b"%PDF-1.4 test", "paper123", "user1")

    result = asyncio.run(_run())

    assert result.page_markdown == ["# Title\n\n![img](p0-img-0.png)", "Page two"]
    assert result.markdown == "# Title\n\n![img](p0-img-0.png)\n\n---\n\nPage two"
    assert result.images[0].id == "p0-img-0.png"
    assert (tmp_path / "paper123" / "ocr" / "p0-img-0.png").exists()


def test_run_mistral_ocr_missing_key():
    async def _run():
        with patch("app.services.ocr_mistral.settings.mistral_api_key", ""):
            with pytest.raises(MistralOcrUnavailable):
                await run_mistral_ocr(b"%PDF", "p1", None)

    asyncio.run(_run())
