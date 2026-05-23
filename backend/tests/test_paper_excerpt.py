"""Tests for section-aware Prepare excerpts."""

from app.services.paper_excerpt import build_prepare_excerpt


def test_excerpt_works_with_markdown_headings():
    raw = (
        "## Introduction\n\n"
        "Intro paragraph one.\n\n"
        "## Methods\n"
        + ("method detail " * 400)
        + "\n\n"
        "## Conclusion\n"
        "We conclude here.\n"
    )
    excerpt = build_prepare_excerpt(raw, max_chars=5000)
    assert "Introduction" in excerpt or "intro" in excerpt.lower()
    assert "conclude" in excerpt.lower() or "Conclusion" in excerpt


def test_excerpt_includes_named_sections():
    raw = (
        "Title line\n\n"
        "1 Introduction\n"
        "Intro paragraph one.\n\n"
        "Intro paragraph two.\n\n"
        "2 Methods\n"
        + ("method detail " * 400)
        + "\n\n"
        "3 Conclusion\n"
        "We conclude here.\n"
    )
    excerpt = build_prepare_excerpt(raw, max_chars=5000)
    assert "Introduction" in excerpt or "intro" in excerpt.lower()
    assert "Conclusion" in excerpt or "conclude" in excerpt.lower()


def test_no_headings_falls_back_to_prefix():
    raw = "x" * 20_000
    excerpt = build_prepare_excerpt(raw, max_chars=8000)
    assert excerpt == raw[:8000]


def test_long_methods_truncated_conclusion_kept():
    raw = (
        "Abstract\n"
        "Short abstract.\n\n"
        "1 Introduction\n"
        "Short intro.\n\n"
        "2 Methods\n"
        + ("x" * 12_000)
        + "\n\n"
        "3 Conclusion\n"
        "Final takeaway.\n"
    )
    excerpt = build_prepare_excerpt(raw, max_chars=4000)
    assert "Final takeaway" in excerpt or "Conclusion" in excerpt
