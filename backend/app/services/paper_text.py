"""Paper text helpers without PDF parser dependencies."""

from __future__ import annotations

from ..models.schemas import ParsedPaper


def paper_prompt_text(paper: ParsedPaper) -> str:
    """Text LLM providers should see — Markdown when OCR succeeded."""
    return (paper.markdown or "").strip() or (paper.raw_text or "")
