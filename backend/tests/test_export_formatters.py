"""Export formatter unit tests."""

from app.services.exports.export_formatters import (
    assumptions_bullets,
    prepare_sections,
    selection_entries,
    summary_sections,
)


def test_summary_sections_extracts_overview():
    content = {"summary": {"overview": "Main claim.", "key_contributions": ["A", "B"]}}
    blocks = summary_sections(content)
    assert any(b[0] == "Overview" for b in blocks)
    assert any(b[0] == "Key contributions" for b in blocks)


def test_prepare_sections_definitions():
    content = {
        "prepare": {
            "definitions": [{"term": "Entropy", "definition": "Measure of disorder."}],
        }
    }
    blocks = prepare_sections(content)
    assert blocks[0][0] == "Definitions"
    assert "Entropy" in blocks[0][1][0]


def test_selection_entries_uses_explanation():
    content = {
        "selection": [
            {
                "action": "explain",
                "selected_text": "We prove X.",
                "explanation": "This states the main result.",
            }
        ]
    }
    rows = selection_entries(content)
    assert len(rows) == 1
    assert rows[0][2] == "This states the main result."


def test_assumptions_bullets():
    content = {"assumptions": {"assumptions": [{"type": "implicit", "statement": "Data is i.i.d."}]}}
    bullets = assumptions_bullets(content)
    assert bullets and "i.i.d." in bullets[0]
