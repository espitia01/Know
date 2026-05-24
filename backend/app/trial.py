"""Anonymous trial demo limits (no auth).

Two independent limits:
  1. IP LLM rate limit — only on upload / summary / selection-stream.
  2. Per-paper selection cap — enforced in ``reserve_trial_selection``.
"""

TRIAL_LLM_RATE_LIMIT = 12
TRIAL_WINDOW = 3600
TRIAL_SELECTION_CAP = 2


class TrialCapExceeded(Exception):
    """Raised when a trial paper has exhausted its selection quota."""


def reserve_trial_selection(p) -> None:
    prev = int(p.cached_analysis.get("trial_selections_used") or 0)
    if prev >= TRIAL_SELECTION_CAP:
        raise TrialCapExceeded()
    p.cached_analysis["trial_selections_used"] = prev + 1


def release_trial_selection(p) -> None:
    prev = int(p.cached_analysis.get("trial_selections_used") or 0)
    p.cached_analysis["trial_selections_used"] = max(0, prev - 1)
