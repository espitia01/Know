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


def test_answer_questions_sanitizes_invalid_sources():
    fake_hits = [
        {"paper_id": None, "chunk_index": 0, "snippet": "bad"},
        {
            "paper_id": "p1",
            "chunk_index": 2,
            "section": "Intro",
            "snippet": "Valid snippet",
            "similarity": 0.9,
        },
    ]
    with patch.object(llm, "get_provider", return_value=_FakeProvider()):
        with patch(
            "app.services.retrieval.retrieve_for_paper",
            new=AsyncMock(return_value=("ctx", fake_hits)),
        ):
            result = asyncio.run(
                llm.answer_questions(
                    "raw paper text", ["what is the model?"], user_id="u1", paper_id="p1"
                )
            )
    from app.models.schemas import QAResponse

    resp = QAResponse(**result)
    assert len(resp.items) == 1
    assert len(resp.items[0].sources) == 1
    assert resp.items[0].sources[0].paper_id == "p1"


def test_parse_qa_payload_uses_prose_when_json_empty():
    raw = (
        "The paper introduces a variational approach to exciton-phonon coupling "
        "with improved numerical stability across temperature ranges."
    )
    result = llm._parse_qa_payload(raw, ["What is the model?"])
    assert "variational" in result["items"][0]["answer"].lower()


def test_parse_qa_payload_raises_on_empty():
    import pytest

    with pytest.raises(ValueError, match="empty payload"):
        llm._parse_qa_payload('{"items": []}', ["What is this?"])
    with pytest.raises(ValueError, match="empty payload"):
        llm._parse_qa_payload("{}", ["What is this?"])


def test_parse_qa_payload_flattens_nested_answer_object():
    raw = """{
      "items": [{
        "question": "What is the main contribution?",
        "answer": {
          "contribution": "The paper evaluates AI-assisted grading workflows.",
          "key_findings": [
            "- OCR conversion is the main challenge.",
            "- Fine-grained rubrics increase error rates."
          ],
          "practical_recommendations": "Use part-level grading when possible."
        },
        "basis": "Grounded in the abstract and results sections."
      }]
    }"""
    result = llm._parse_qa_payload(raw, ["What is the main contribution?"])
    answer = result["items"][0]["answer"]
    assert "AI-assisted grading workflows" in answer
    assert "OCR conversion" in answer
    assert "Fine-grained rubrics" in answer
    assert "part-level grading" in answer
    assert "abstract and results" in answer
    assert answer.strip().startswith("**Contribution:**")
    assert "{" not in answer
