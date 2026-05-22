"""Anchored Q&A (Prompt 10 Track C): retrieval hits should ride along on each item."""

import asyncio
from unittest.mock import AsyncMock, patch

from app.services import llm


class _FakeProvider:
    async def complete(self, system, user, max_tokens=4096, *, cache_user_prefix=None):
        return (
            '{"items": [{"question": "what is the model?", '
            '"answer": "It uses convolutional layers."}]}'
        )


def test_answer_questions_stamps_sources_on_each_item():
    fake_hits = [
        {
            "paper_id": "p1",
            "chunk_index": 3,
            "section": "Methods",
            "snippet": "We use convolutional layers …",
            "similarity": 0.81,
        }
    ]
    with patch.object(llm, "get_provider", return_value=_FakeProvider()):
        with patch(
            "app.services.retrieval.retrieve_for_paper",
            new=AsyncMock(return_value=("retrieved-context", fake_hits)),
        ):
            result = asyncio.run(
                llm.answer_questions(
                    "raw paper text", ["what is the model?"], user_id=None, paper_id="p1"
                )
            )
    assert isinstance(result, dict)
    items = result.get("items")
    assert isinstance(items, list) and items
    assert items[0]["sources"] == fake_hits


def test_answer_questions_omits_sources_when_no_retrieval():
    with patch.object(llm, "get_provider", return_value=_FakeProvider()):
        with patch(
            "app.services.retrieval.retrieve_for_paper",
            new=AsyncMock(return_value=("", [])),
        ):
            result = asyncio.run(
                llm.answer_questions(
                    "raw paper text", ["what is the model?"], user_id=None, paper_id="p1"
                )
            )
    items = result.get("items") if isinstance(result, dict) else None
    assert items
    assert items[0].get("sources", []) == []
