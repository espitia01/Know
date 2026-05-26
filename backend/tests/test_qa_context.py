from app.models.schemas import FigureInfo, ParsedPaper
from app.services.qa_context import build_qa_visual_context, _extract_markdown_tables


def test_extract_markdown_tables_includes_caption_and_rows():
    md = """Some intro.

Table 1. Accuracy by rubric granularity.

| Rubric | Accuracy |
| --- | --- |
| Fine | 0.62 |
| Coarse | 0.81 |
"""
    blocks = _extract_markdown_tables(md, max_chars=2000)
    assert blocks
    label, block = blocks[0]
    assert "Table 1" in label or "Table 1" in block
    assert "0.81" in block


def test_build_qa_visual_context_includes_figures_tables_and_summary():
    paper = ParsedPaper(
        id="p1",
        title="Thermo grading",
        markdown=(
            "Table 2. OCR error rates.\n\n"
            "| Engine | Error |\n| --- | --- |\n| A | 0.12 |\n"
        ),
        figures=[
            FigureInfo(
                id="fig-1",
                url="/fig-1.png",
                caption="Figure 1. Example handwritten exam page.",
                page=2,
            )
        ],
        cached_analysis={
            "summary": {
                "key_figures_and_tables": [
                    {
                        "id": "Table 2",
                        "description": "Compares OCR engines on handwritten thermodynamics exams.",
                    }
                ]
            },
            "figure_analyses": [
                {
                    "figure_id": "fig-1",
                    "question": "What does this figure show?",
                    "description": "A scanned exam page with thermodynamics free-body diagrams.",
                    "key_observations": ["Hand-drawn axes", "Mixed print and handwriting"],
                    "relation_to_paper": "Illustrates the grading input format.",
                }
            ],
        },
    )
    ctx = build_qa_visual_context(paper, "What does Figure 1 show in Table 2?", max_chars=4000)
    assert "Figure 1" in ctx
    assert "Table 2" in ctx
    assert "OCR engines" in ctx
    assert "free-body" in ctx or "thermodynamics" in ctx.lower()
    assert "0.12" in ctx
