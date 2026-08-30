"""Billing helpers: redirect allowlist, plan-change rules, checkout guard."""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.billing import (
    _assert_paid_plan_change,
    create_checkout_session,
    is_safe_redirect_url,
    redirect_hosts,
)


def test_redirect_hosts_include_localhost_and_cors(monkeypatch):
    monkeypatch.setenv("KNOW_CORS_ORIGINS", "https://know.example.com, https://app.vercel.app")
    hosts = redirect_hosts()
    assert "localhost:3000" in hosts
    assert "know.example.com" in hosts
    assert "app.vercel.app" in hosts


def test_is_safe_redirect_url_rejects_foreign_hosts():
    hosts = {"localhost:3000", "know.app"}
    assert is_safe_redirect_url("https://know.app/dashboard?upgraded=1", hosts)
    assert is_safe_redirect_url("https://www.know.app/dashboard?upgraded=1", hosts)
    assert is_safe_redirect_url("http://localhost:3000/#pricing", hosts)
    assert not is_safe_redirect_url("https://evil.example/phish", hosts)
    assert not is_safe_redirect_url("javascript:alert(1)", hosts)


def test_redirect_hosts_include_www_twin(monkeypatch):
    monkeypatch.setenv("KNOW_CORS_ORIGINS", "https://know.app")
    hosts = redirect_hosts()
    assert "know.app" in hosts
    assert "www.know.app" in hosts


def test_paid_plan_change_allows_downgrade():
    _assert_paid_plan_change("researcher", "scholar")
    _assert_paid_plan_change("scholar", "researcher")
    with pytest.raises(HTTPException) as same:
        _assert_paid_plan_change("scholar", "scholar")
    assert same.value.status_code == 400
    with pytest.raises(HTTPException) as free:
        _assert_paid_plan_change("free", "researcher")
    assert free.value.status_code == 400


def test_checkout_refuses_second_subscription():
    with (
        patch("app.api.billing.settings") as settings,
        patch("app.api.billing.get_user", return_value={"stripe_customer_id": "cus_1"}),
        patch("app.api.billing._list_current_subscriptions", return_value=[MagicMock(id="sub_1")]),
    ):
        settings.stripe_secret_key = "sk_test"
        settings.stripe_price_scholar = "price_s"
        settings.stripe_price_researcher = "price_r"
        with pytest.raises(HTTPException) as ei:
            import asyncio

            asyncio.run(create_checkout_session({"tier": "researcher"}, user_id="user_1"))
        assert ei.value.status_code == 409
        assert ei.value.detail["code"] == "already_subscribed"
