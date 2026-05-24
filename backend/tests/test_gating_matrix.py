"""Tier gating enforcement tests for multi-provider model matrix."""

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.gating import enforce_model, reserve_usage, release_usage


@patch("app.gating.get_user_tier", return_value="free")
@patch("app.gating.reserve_daily_api_usage", return_value=1)
@patch("app.gating.reserve_daily_capability_usage", return_value=1)
@patch("app.gating.reserve_paper_usage", return_value=1)
def test_free_tier_cannot_save_opus(_paper, _cap, _daily, _tier):
    assert enforce_model("free-user", "claude-opus-4-7") == "mistral-small-latest"


@patch("app.gating.get_user_tier", return_value="scholar")
def test_scholar_downgrade_keeps_anthropic(_tier):
    assert enforce_model("scholar-user", "claude-opus-4-7") == "claude-sonnet-4-6"


@patch("app.gating.get_user_tier", return_value="free")
@patch("app.gating.reserve_daily_api_usage", return_value=1)
@patch("app.gating.reserve_daily_capability_usage", return_value=1)
@patch("app.gating.reserve_paper_usage", return_value=1)
def test_per_model_cap_charges_enforced_model_not_requested(
    _paper, _cap_usage, _daily, _tier
):
    requested = "claude-opus-4-7"
    enforced = enforce_model("free-user", requested)
    assert enforced == "mistral-small-latest"
    token = reserve_usage("free-user", "paper-x", "qa", model=enforced)
    assert token["model"] == "mistral-small-latest"
    release_usage(token)


@patch("app.gating.get_user_tier", return_value="free")
def test_free_user_sonnet_model_tier_locked(_tier):
    with pytest.raises(HTTPException) as exc:
        reserve_usage("free-user", "paper-x", "qa", model="claude-sonnet-4-6")
    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "model_tier_locked"


@patch("app.gating.get_user_tier", return_value="researcher")
@patch("app.gating.reserve_daily_api_usage", return_value=1)
@patch("app.gating.reserve_paper_usage", return_value=1)
def test_combined_fast_cap_shared_across_providers(_paper, _daily, _tier):
    counts = {"fast": 0}

    def cap_reserve(user_id, today, capability, delta, max_cap):
        counts[capability] = counts.get(capability, 0) + delta
        if counts[capability] > max_cap:
            counts[capability] -= delta
            return -1
        return counts[capability]

    models = (
        ["claude-haiku-4-5", "gpt-5-mini", "mistral-small-latest"] * 100
    )[:300]

    with patch("app.gating.reserve_daily_capability_usage", side_effect=cap_reserve):
        for model in models:
            reserve_usage("researcher-user", "paper-x", "qa", model=model)

        with pytest.raises(HTTPException) as exc:
            reserve_usage(
                "researcher-user",
                "paper-x",
                "qa",
                model="mistral-small-latest",
            )
        assert exc.value.status_code == 429
        assert exc.value.detail["code"] == "capability_cap"
        assert exc.value.detail["capability"] == "fast"
