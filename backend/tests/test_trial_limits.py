"""Trial demo limit helpers — per-paper selection cap."""

from app.trial import (
    TRIAL_LLM_RATE_LIMIT,
    TRIAL_SELECTION_CAP,
    TrialCapExceeded,
    release_trial_selection,
    reserve_trial_selection,
)


class _FakePaper:
    def __init__(self, used: int = 0):
        self.cached_analysis = {"trial_selections_used": used}


def test_trial_selection_cap_allows_two_then_blocks():
    paper = _FakePaper(0)
    reserve_trial_selection(paper)
    assert paper.cached_analysis["trial_selections_used"] == 1
    reserve_trial_selection(paper)
    assert paper.cached_analysis["trial_selections_used"] == 2
    try:
        reserve_trial_selection(paper)
        assert False, "expected cap exceeded"
    except TrialCapExceeded:
        pass


def test_release_trial_selection_never_negative():
    paper = _FakePaper(0)
    release_trial_selection(paper)
    assert paper.cached_analysis["trial_selections_used"] == 0

    paper = _FakePaper(1)
    release_trial_selection(paper)
    assert paper.cached_analysis["trial_selections_used"] == 0


def test_trial_llm_rate_limit_is_generous_enough_for_demo_flow():
    # upload + summary + two selections = 4 LLM calls; leave headroom for retries.
    assert TRIAL_LLM_RATE_LIMIT >= 4
    assert TRIAL_SELECTION_CAP == 2
