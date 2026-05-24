"""Tests for internal paper text guardrails."""

import asyncio
import sys
import types
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.internal import internal_paper_text


def test_internal_paper_text_whitespace_returns_409():
    paper = MagicMock()
    fake_pdf_parser = types.ModuleType("app.services.pdf_parser")
    fake_pdf_parser.get_paper = MagicMock(return_value=paper)
    fake_pdf_parser.paper_prompt_text = MagicMock(return_value="   ")

    with patch("app.services.db.get_paper_meta", return_value={"id": "paper1"}):
        with patch.dict(sys.modules, {"app.services.pdf_parser": fake_pdf_parser}):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(internal_paper_text("paper1", "user1"))
            assert exc.value.status_code == 409
            assert exc.value.detail["code"] == "paper_text_unavailable"
