"""Tests for bibliography chunk splitting."""

from app.services.citation_resolve import split_bibliography_chunks


def test_split_inline_numbered_line():
    bib = (
        "1. Smith, J. Title one. 2017. "
        "2. Jones, A. Title two. 2019. "
        "3. Lee, B. Title three. 2021."
    )
    chunks = split_bibliography_chunks(bib)
    assert len(chunks) >= 2
    assert all(len(v) <= 4000 for v in chunks.values())


def test_sentence_split_fallback_no_markers():
    bib = (
        "Smith, J. Nature. 2017. "
        "Jones, A., Brown, C. Science. 2019. "
        "Lee, B. Cell. 2021."
    ) * 5
    chunks = split_bibliography_chunks(bib)
    assert chunks
    assert max(len(v) for v in chunks.values()) <= 4000


def test_single_short_reference_unchanged():
    bib = "Smith, J. A short note. Nature. 2020."
    chunks = split_bibliography_chunks(bib)
    assert chunks
    assert max(len(v) for v in chunks.values()) <= 1200
