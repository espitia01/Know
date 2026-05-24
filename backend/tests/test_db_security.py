"""Database security helpers (migration 022)."""

from app.services.db import StripeDedupError, delete_paper_dependents
from app.trial import TrialCapExceeded, reserve_trial_selection


class _FakePaper:
    def __init__(self, used: int = 0):
        self.cached_analysis = {"trial_selections_used": used}


def test_trial_selection_cap_unchanged():
    paper = _FakePaper(0)
    reserve_trial_selection(paper)
    reserve_trial_selection(paper)
    try:
        reserve_trial_selection(paper)
        assert False, "expected cap"
    except TrialCapExceeded:
        pass


def test_stripe_dedup_error_is_distinct():
    assert issubclass(StripeDedupError, Exception)


def test_delete_paper_dependents_noop_without_db(monkeypatch):
    monkeypatch.setattr("app.services.db.get_db", lambda: None)
    delete_paper_dependents("paper1", "user1")
