"""Tests for Prepare (analyze_paper) validation."""

import asyncio

import pytest
from unittest.mock import AsyncMock, patch

from app.services import llm


def test_analyze_paper_raises_on_empty_raw():
    provider = AsyncMock()
    provider.model = "claude-sonnet-4-6"
    provider.complete = AsyncMock(return_value="")

    async def run():
        with patch.object(llm, "get_provider", return_value=provider):
            with pytest.raises(ValueError, match="empty payload"):
                await llm.analyze_paper("paper body", user_id=None)

    asyncio.run(run())


def test_analyze_paper_raises_on_no_useful_fields():
    provider = AsyncMock()
    provider.model = "claude-sonnet-4-6"
    provider.complete = AsyncMock(return_value='{"prior_work": []}')

    async def run():
        with patch.object(llm, "get_provider", return_value=provider):
            with pytest.raises(ValueError, match="empty payload"):
                await llm.analyze_paper("paper body", user_id=None)

    asyncio.run(run())


def test_analyze_paper_accepts_partial_payload():
    provider = AsyncMock()
    provider.model = "claude-sonnet-4-6"
    provider.complete = AsyncMock(
        return_value='{"definitions": [{"term": "x", "definition": "y"}], "concepts": []}'
    )

    async def run():
        with patch.object(llm, "get_provider", return_value=provider):
            return await llm.analyze_paper("paper body", user_id=None)

    result = asyncio.run(run())
    assert result.get("definitions")


def test_is_usable_prepare_payload():
    assert llm._is_usable_prepare_payload({"definitions": [{"term": "a"}]})
    assert not llm._is_usable_prepare_payload({})
    assert not llm._is_usable_prepare_payload({"prior_work": [{"title": "b"}]})
