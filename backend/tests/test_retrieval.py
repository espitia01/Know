"""Tests for retrieval helpers (Track D)."""

from app.services.retrieval import _chunk_text


def test_chunk_text_splits_long_paper():
    text = ("Paragraph one.\n\n" + "Word " * 500).strip()
    chunks = _chunk_text(text)
    assert len(chunks) >= 2
    assert all(len(c) <= 1300 for c in chunks)
