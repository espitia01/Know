from app.models.schemas import ParsedPaper
from app.services.paper_text import paper_prompt_text


def test_paper_prompt_text_prefers_markdown():
    paper = ParsedPaper(id="p1", title="T", markdown="# Hello", raw_text="plain")
    assert paper_prompt_text(paper) == "# Hello"


def test_paper_prompt_text_falls_back_to_raw():
    paper = ParsedPaper(id="p1", title="T", markdown="", raw_text="plain text")
    assert paper_prompt_text(paper) == "plain text"
