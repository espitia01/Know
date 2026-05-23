"""Canonical analysis inputs — Mistral OCR markdown + OCR figure ids."""

from __future__ import annotations

from ..models.schemas import ParsedPaper
from .paper_text import paper_prompt_text


def text_for_analysis(paper: ParsedPaper) -> str:
    """Text all LLM / embedding paths should use."""
    return paper_prompt_text(paper)


def clear_text_derived_analysis(paper: ParsedPaper) -> None:
    """Drop cached analysis computed before OCR markdown was available."""
    paper.cached_analysis = {}
