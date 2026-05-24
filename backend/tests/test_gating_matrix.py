"""Tier gating enforcement tests for multi-provider model matrix."""

from unittest.mock import patch

from app.gating import enforce_model, reserve_usage, release_usage


@patch("app.gating.get_user_tier", return_value="free")
@patch("app.gating.reserve_daily_api_usage", return_value=1)
@patch("app.gating.reserve_daily_model_usage", return_value=1)
@patch("app.gating.reserve_paper_usage", return_value=1)
def test_free_tier_cannot_save_opus(_paper, _model, _daily, _tier):
    assert enforce_model("free-user", "claude-opus-4-7") == "mistral-small-latest"


@patch("app.gating.get_user_tier", return_value="scholar")
def test_scholar_downgrade_keeps_anthropic(_tier):
    assert enforce_model("scholar-user", "claude-opus-4-7") == "claude-sonnet-4-6"


@patch("app.gating.get_user_tier", return_value="free")
@patch("app.gating.reserve_daily_api_usage", return_value=1)
@patch("app.gating.reserve_daily_model_usage", return_value=1)
@patch("app.gating.reserve_paper_usage", return_value=1)
def test_per_model_cap_charges_enforced_model_not_requested(
    _paper, _model_usage, _daily, _tier
):
    requested = "claude-opus-4-7"
    enforced = enforce_model("free-user", requested)
    assert enforced == "mistral-small-latest"
    token = reserve_usage("free-user", "paper-x", "qa", model=enforced)
    assert token["model"] == "mistral-small-latest"
    release_usage(token)
