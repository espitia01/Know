"""Tests for multi-provider LLM dispatch and model canonicalization."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.gating import ALL_MODELS, canonicalize_model, enforce_model, get_allowed_models
from app.services.llm import (
    LLMProviderError,
    OpenAIProvider,
    MistralProvider,
    _make_provider,
    _openai_token_fields,
    _provider_for_slug,
)


def test_provider_for_slug_dispatch():
    assert _provider_for_slug("claude-haiku-4-5") == "anthropic"
    assert _provider_for_slug("gpt-5-mini") == "openai"
    assert _provider_for_slug("mistral-small-latest") == "mistral"
    assert _provider_for_slug("pixtral-large-latest") == "mistral"
    with pytest.raises(LLMProviderError):
        _provider_for_slug("unknown-model")


def test_enforce_model_canonicalizes_aliases():
    assert canonicalize_model("gpt-4o") == "gpt-5-mini"
    assert canonicalize_model("mistral-tiny") == "mistral-small-latest"


@patch("app.gating.get_user_tier", return_value="free")
def test_tier_gating_defaults_free(_tier):
    assert enforce_model("user-free", "gpt-5") == "mistral-small-latest"
    assert enforce_model("user-free", "claude-opus-5") == "mistral-small-latest"


@patch("app.gating.get_user_tier", return_value="scholar")
def test_tier_gating_defaults_scholar(_tier):
    assert enforce_model("user-scholar", "claude-opus-5") == "claude-sonnet-5"
    assert enforce_model("user-scholar", "claude-opus-4-7") == "claude-sonnet-5"


@patch("app.gating.get_user_tier", return_value="researcher")
def test_researcher_allowed_models(_tier):
    allowed = get_allowed_models("user-researcher")
    assert set(allowed) == set(ALL_MODELS)
    assert len(allowed) == 9


def test_openai_token_fields_gpt5():
    fields = _openai_token_fields("gpt-5-mini", 1000)
    assert fields == {"max_completion_tokens": 1000}


def test_openai_token_fields_legacy():
    fields = _openai_token_fields("gpt-4.1", 1000)
    assert fields == {"max_tokens": 1000}


@patch("app.services.llm.settings")
def test_make_provider_openai(mock_settings):
    mock_settings.openai_api_key = "sk-test"
    provider = _make_provider("gpt-5-mini")
    assert isinstance(provider, OpenAIProvider)
    assert provider.model == "gpt-5-mini"


@patch("app.services.llm.settings")
def test_make_provider_mistral(mock_settings):
    mock_settings.mistral_api_key = "sk-test"
    provider = _make_provider("mistral-small-latest")
    assert isinstance(provider, MistralProvider)


def test_openai_complete_uses_responses_api_for_gpt5():
    """gpt-5+ slugs route through /v1/responses, not /v1/chat/completions."""
    async def run():
        provider = OpenAIProvider("sk-test", "gpt-5-mini")
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "output_text": "hello",
            "usage": {"input_tokens": 1, "output_tokens": 2},
        }
        provider.client = AsyncMock()
        provider.client.post = AsyncMock(return_value=mock_response)
        result = await provider.complete("sys", "user", max_tokens=512)
        assert result == "hello"
        url = provider.client.post.call_args.args[0]
        assert url.endswith("/v1/responses")
        body = provider.client.post.call_args.kwargs["json"]
        assert body["model"] == "gpt-5-mini"
        assert body["instructions"] == "sys"
        assert body["input"] == "user"
        assert body["max_output_tokens"] == 512
        assert body["text"]["format"]["type"] == "json_object"

    asyncio.run(run())


def test_openai_complete_uses_chat_completions_for_legacy():
    """Pre-GPT-5 slugs (gpt-4o, gpt-4.1, etc.) keep using chat-completions."""
    async def run():
        provider = OpenAIProvider("sk-test", "gpt-4o-mini")
        mock_response = MagicMock()
        mock_response.is_success = True
        mock_response.json.return_value = {
            "choices": [{"message": {"content": "hello"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2},
        }
        provider.client = AsyncMock()
        provider.client.post = AsyncMock(return_value=mock_response)
        result = await provider.complete("sys", "user", max_tokens=512)
        assert result == "hello"
        url = provider.client.post.call_args.args[0]
        assert url.endswith("/v1/chat/completions")
        body = provider.client.post.call_args.kwargs["json"]
        assert body["max_tokens"] == 512

    asyncio.run(run())
