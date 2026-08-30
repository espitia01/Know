"""LaTeX / Beamer export source generation (compile is optional)."""

from app.models.schemas import ParsedPaper
from app.services.exports.content import gather_export_context
from app.services.exports.latex_render import build_article_tex, build_beamer_tex


def _paper() -> ParsedPaper:
    return ParsedPaper(
        id="tex1",
        title="Sample Paper on Quantum Fields",
        authors=["Alice Author"],
        cached_analysis={
            "summary": {
                "overview": "This paper studies $x^2$ behavior.",
                "key_contributions": ["First result", "Second result"],
            }
        },
    )


def test_article_tex_contains_documentclass_and_math():
    paper = _paper()
    cache = gather_export_context(paper, "u1", ["summary"])
    tex = build_article_tex(paper, cache, ["summary"])
    assert r"\documentclass[11pt]{article}" in tex
    assert "Sample Paper" in tex
    assert r"$x^2$" in tex
    assert r"\end{document}" in tex


def test_beamer_tex_contains_frames():
    paper = _paper()
    cache = gather_export_context(paper, "u1", ["summary"])
    tex = build_beamer_tex(paper, cache, ["summary"])
    assert r"\documentclass[aspectratio=169]{beamer}" in tex
    assert r"\begin{frame}" in tex
    assert "Summary" in tex
