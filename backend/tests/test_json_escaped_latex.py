from app.services.llm import _repair_json_escaped_latex


def test_repair_json_escaped_latex_transformer_snippet():
    raw = (
        "egin{aligned} ext{Encoder: } oldsymbol{z} &= ext{Encoder}(oldsymbol{x}_1) "
        "ight. ight."
    )
    fixed = _repair_json_escaped_latex(raw)
    assert "\\begin{aligned}" in fixed
    assert "\\text{Encoder" in fixed
    assert "\\boldsymbol{z}" in fixed
    assert fixed.count("\\right.") == 1
