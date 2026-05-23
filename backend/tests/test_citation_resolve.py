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


def test_infers_leading_unnumbered_first_reference():
    bib = (
        "M. Rohlfing and S. G. Louie, Phys. Rev. Lett. 81, 2312 (1998).\n"
        "[2] M. Rohlfing and S. G. Louie, Phys. Rev. B 62, 4927 (2000).\n"
        "[3] F. Mauri and R. Car, Phys. Rev. Lett. 75, 3166 (1995)."
    )
    chunks = split_bibliography_chunks(bib)
    assert "1" in chunks
    assert "2" in chunks
    assert "TABLE" not in chunks.get("3", "")


def test_truncates_table_bleed_on_last_chunk():
    bib = (
        "[13] M. I. McCarthy, P. Rosums, J. Chem. Phys. 86, 6693 (1987).\n"
        "TABLE II. Ground-state and excited-state data for NH3:"
    )
    chunks = split_bibliography_chunks(bib)
    assert "13" in chunks
    assert "TABLE II" not in chunks["13"]
