"""PDF export smoke tests."""

from __future__ import annotations

from app.models.schemas import ParsedPaper
from app.services.exports.content import gather_export_context
from app.services.exports.pdf_render import render_pdf


def test_render_pdf_returns_pdf_bytes():
    paper = ParsedPaper(
        id="test1",
        title="Sample Paper on Quantum Fields",
        authors=["Alice Author"],
        cached_analysis={
            "summary": {
                "overview": "This paper studies $x^2$ behavior.",
                "key_contributions": ["First result", "Second result"],
            }
        },
    )
    export_row = {
        "user_id": "u1",
        "sections": ["summary"],
        "options": {"pdf": {"paper_size": "Letter", "include_figures": False}},
    }
    cache = gather_export_context(paper, "u1", ["summary"])
    data, ctype, filename = render_pdf(export_row, paper, cache)
    assert data[:4] == b"%PDF"
    assert ctype == "application/pdf"
    assert filename.endswith(".pdf")


def test_render_pdf_empty_section_placeholder():
    paper = ParsedPaper(id="t2", title="Empty", authors=[], cached_analysis={})
    export_row = {"user_id": "u1", "sections": ["qa"], "options": {}}
    cache = gather_export_context(paper, "u1", ["qa"])
    data, _, _ = render_pdf(export_row, paper, cache)
    assert data[:4] == b"%PDF"
