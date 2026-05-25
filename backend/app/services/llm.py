"""LLM service abstraction with Anthropic, OpenAI, and Mistral providers."""

from __future__ import annotations

import json
import re
import io
from abc import ABC, abstractmethod
from typing import AsyncIterator

import logging

import httpx
import ssl
import certifi
from fastapi import HTTPException

from ..config import settings
from .paper_excerpt import build_prepare_excerpt
from .reference_extract import extract_references_section

logger = logging.getLogger(__name__)

from ..gating import resolve_deep_analysis

DEEP_MULTIPLIER = 2
STD_BUDGETS = {
    "summary": {"context": 12000, "selection": 0, "history": 0},
    "selection": {"context": 6000, "selection": 4000, "history": 0},
    "qa": {"context": 6000, "selection": 0, "history": 0},
    "figure": {"context": 6000, "selection": 0, "history": 0},
    "assumptions": {"context": 6000, "selection": 0, "history": 0},
}


def _scale_budget(budget: dict, factor: int) -> dict:
    return {k: (v * factor if v else 0) for k, v in budget.items()}


DEEP_BUDGETS = {k: _scale_budget(v, DEEP_MULTIPLIER) for k, v in STD_BUDGETS.items()}


def get_budgets(kind: str, user_id: str | None) -> dict:
    deep = bool(user_id) and resolve_deep_analysis(user_id)
    table = DEEP_BUDGETS if deep else STD_BUDGETS
    return table.get(kind, STD_BUDGETS["qa"])

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
# Current Anthropic model aliases as of April 2026. The previous Opus
# ID (``claude-opus-4``) was never valid on the Messages API — it's a
# user-facing name. Anthropic's alias is ``claude-opus-4-7`` for the
# current generation. Leaving the old string in place caused every
# Opus call to 4xx with "unknown model" and surfaced to the user as
# "I get errors after switching to opus/sonnet".
HAIKU_MODEL = "claude-haiku-4-5"
SONNET_MODEL = "claude-sonnet-4-6"
OPUS_MODEL = "claude-opus-4-7"

MAX_IMAGE_DIMENSION = 1024

LATEX_FORMAT_INSTRUCTIONS = """LATEX FORMATTING RULES (STRICT — follow exactly):
- Use $...$ for inline math (variables, single symbols, short expressions)
- Use $$...$$ for display math (any equation with \\frac, \\sum, \\int, \\prod, \\lim, matrices, multi-line expressions, or anything longer than a few tokens)
- Put each display equation on its own line with a blank line before and after the $$...$$ block
- NEVER use \\( \\) or \\[ \\] delimiters — always $ or $$
- NEVER output Unicode math characters (e.g. σ, μ, ∑, ∫, Γ, Δ, Ω, superscripts/subscripts-as-Unicode…). ALWAYS write them in LaTeX: \\sigma, \\mu, \\sum, \\int, \\Gamma, \\Omega, etc.
- NEVER mix bare/raw symbols and LaTeX in the same expression. If an equation has ANY math, wrap the ENTIRE equation in $...$ or $$...$$
- For matrices use \\begin{pmatrix}...\\end{pmatrix} (or bmatrix/vmatrix) inside $$...$$
- For multi-character function names use \\operatorname{name} or \\text{name}; for word-like subscripts use \\mathrm{} (e.g. $d_{\\mathrm{DW}}$, $\\Delta V_{\\mathrm{S}}$)
- Use \\mathbf{R} or \\boldsymbol{r} for vectors when \\mathbf{} is clearer than bare italic
- Ratios stacked vertically MUST use \\frac{…}{…} inside math — never imitate fractions with glyphs split across lines (e.g. write $\\frac{P(\\mathbf{R})}{2\\epsilon_0}$, not prose lines with P, then denominator, then e^{-G|z|} scattered)
- Use \\left| \\right| for norms / magnitudes over multi-symbol expressions — never vertically split '|' glyphs across lines outside math
- Do not break a single equation into multiple $...$ fragments — keep it as one continuous math expression
- NEVER insert line breaks between individual characters, tokens, or short lines inside prose OR inside math (absolutely forbid 'one glyph per line' columns that spell English or LaTeX)
- For numbered multi-line alignments use $$\n\\begin{aligned} … \\end{aligned}\n$$ (centered display); NEVER split one equation across multiple paragraphs or lines of plain text

PROSE AND READABILITY (same priority as math):
- Write normal English: spaces between every word — NEVER concatenate sentences (wrong: Theresearchcombines… ; right: The research combines …)
- Paragraphs flow as full sentences or bullet lines; lists use markdown `-` or numbering with each item readable on one screen line where possible

DEFINITION AND "RECOGNIZE PARAMETERS" STYLE:
- Prefer `- **Symbol / name** ($expression$):` one-line description OR two lines max (definition, then intuition) — NOT a vertical stack of isolated letters/Greek/plus/parens
- For each physical quantity: introduce it with concise inline math (e.g. $P(\\mathbf{R})$, $G$); optionally add ONE display equation for the defining relation instead of repeating the same relation in three broken forms

BAD OUTPUT PATTERNS (never produce these):
- A block that lists one Latin letter per line spelling a sentence ("Electrostatic surface potential…") or repeating the same caption under garbled typography
- Stray `$`/`$$` in prose: every display block opens and closes with `$$`; never leave orphan `$$` glued to trailing math (invalid: "... $2\\epsilon_0$$ continues" outside a complete display block — use $\\frac{\\cdots}{2\\epsilon_0}$ inline or rewrite as a standalone $$ block)
- Duplicating identical content as (1) glued run-on text, (2) vertical-character salad, AND (3) proper math — pick ONE concise prose paragraph plus ONE canonical $ or $$ formulation

RENDERER NOTES (KaTeX): favor standard AMS-style constructs (\\begin{aligned}, \\frac, \\sqrt, \\int, \\mathrm) and environments already listed above — avoid obscure packages or TikZ."""


def _ssl_context():
    """Build an SSL context, preferring certifi, falling back to system certs."""
    try:
        return ssl.create_default_context(cafile=certifi.where())
    except ssl.SSLError:
        return ssl.create_default_context()


class LLMProvider(ABC):
    @abstractmethod
    async def complete(
        self,
        system: str,
        user: str,
        max_tokens: int = 4096,
        *,
        cache_user_prefix: str | None = None,
    ) -> str: ...


class LLMProviderError(HTTPException):
    """Raised when the upstream model provider rejects a request.

    We deliberately subclass ``HTTPException`` rather than a plain
    ``RuntimeError`` so every route's existing ``except HTTPException:
    release_usage(token); raise`` branch automatically surfaces the
    real, structured error (e.g. "Model 'claude-opus-4' is not
    available") instead of the broader ``except Exception`` branch
    converting it into a generic 500. Before this change, typos in a
    model alias looked like random outages to the user.
    """

    def __init__(self, status: int, message: str, *, model: str | None = None):
        detail = {"code": "llm_provider", "message": message}
        if model:
            detail["model"] = model
        super().__init__(status_code=int(status), detail=detail)
        self.message = message
        self.model = model


def _raise_for_anthropic(response: httpx.Response, *, model: str) -> None:
    """Translate a non-2xx Anthropic response into an ``LLMProviderError``.

    We read a small, bounded chunk of the body to extract the
    Anthropic-provided ``error.message`` without propagating huge
    payloads through logs. The provider error message is the truth of
    why the call failed, and burying it in "LLM call failed" is what
    made model typos (``claude-opus-4``) look like random outages.
    """
    if response.is_success:
        return
    status = response.status_code
    text = ""
    try:
        data = response.json()
        if isinstance(data, dict):
            err = data.get("error") or {}
            if isinstance(err, dict):
                text = str(err.get("message") or "") or str(err.get("type") or "")
    except Exception:
        pass
    if not text:
        try:
            text = (response.text or "")[:500]
        except Exception:
            text = ""
    # Map upstream statuses to a safe outbound status. 4xx from the
    # provider usually means a client-ish problem (bad model id, cap,
    # etc.) but we don't want to proxy a raw 401 back — that would let
    # the frontend think the *user* isn't signed in. 502 is the right
    # story: "the upstream got our request, and rejected it".
    out_status = 502
    if status == 429:
        out_status = 429
    if status == 400 and ("model" in text.lower() or not text):
        msg = f"Selected model '{model}' is not available from Anthropic. Pick another model in Settings."
    elif status in (401, 403):
        msg = "Anthropic authentication failed — the API key in server config is invalid or revoked."
    elif status == 429:
        msg = "Anthropic rate limit hit — please wait a moment and try again."
    elif status >= 500:
        msg = "Anthropic service is having trouble right now. Please try again in a few moments."
        out_status = 503
    else:
        msg = text or f"Anthropic returned HTTP {status}."
    raise LLMProviderError(out_status, msg, model=model)


def _raise_for_openai(response: httpx.Response, *, model: str) -> None:
    """Translate a non-2xx OpenAI chat-completions response."""
    if response.is_success:
        return
    status = response.status_code
    text = ""
    try:
        data = response.json()
        if isinstance(data, dict):
            err = data.get("error") or {}
            if isinstance(err, dict):
                text = str(err.get("message") or "") or str(err.get("type") or "")
    except Exception:
        pass
    if not text:
        try:
            text = (response.text or "")[:500]
        except Exception:
            text = ""
    out_status = 502
    if status == 429:
        out_status = 429
    if status == 400 and ("model" in text.lower() or not text):
        msg = f"Selected model '{model}' is not available from OpenAI. Pick another model in Settings."
    elif status in (401, 403):
        msg = "OpenAI authentication failed — the API key in server config is invalid or revoked."
    elif status == 429:
        msg = "OpenAI rate limit hit — please wait a moment and try again."
    elif status >= 500:
        msg = "OpenAI service is having trouble right now. Please try again in a few moments."
        out_status = 503
    else:
        msg = text or f"OpenAI returned HTTP {status}."
    raise LLMProviderError(out_status, msg, model=model)


def _raise_for_mistral(response: httpx.Response, *, model: str) -> None:
    """Translate a non-2xx Mistral chat-completions response."""
    if response.is_success:
        return
    status = response.status_code
    text = ""
    try:
        data = response.json()
        if isinstance(data, dict):
            text = str(data.get("message") or "")
            if not text:
                err = data.get("error") or {}
                if isinstance(err, dict):
                    text = str(err.get("message") or "") or str(err.get("type") or "")
    except Exception:
        pass
    if not text:
        try:
            text = (response.text or "")[:500]
        except Exception:
            text = ""
    out_status = 502
    if status == 429:
        out_status = 429
    if status == 400 and ("model" in text.lower() or not text):
        msg = f"Selected model '{model}' is not available from Mistral. Pick another model in Settings."
    elif status in (401, 403):
        msg = "Mistral authentication failed — the API key in server config is invalid or revoked."
    elif status == 429:
        msg = "Mistral rate limit hit — please wait a moment and try again."
    elif status >= 500:
        msg = "Mistral service is having trouble right now. Please try again in a few moments."
        out_status = 503
    else:
        msg = text or f"Mistral returned HTTP {status}."
    raise LLMProviderError(out_status, msg, model=model)


def _log_chat_usage(provider: str, model: str, usage: dict) -> None:
    logger.info(
        "%s_usage model=%s input=%s output=%s",
        provider,
        model,
        usage.get("prompt_tokens") or usage.get("input_tokens") or 0,
        usage.get("completion_tokens") or usage.get("output_tokens") or 0,
    )


def _openai_token_fields(slug: str, max_tokens: int) -> dict:
    """GPT-5+ uses max_completion_tokens; older models use max_tokens."""
    if slug.startswith("gpt-5"):
        return {"max_completion_tokens": max_tokens, "max_tokens": max_tokens}
    return {"max_tokens": max_tokens}


_shared_http_client: httpx.AsyncClient | None = None


def _get_shared_client() -> httpx.AsyncClient:
    global _shared_http_client
    if _shared_http_client is None or _shared_http_client.is_closed:
        _shared_http_client = httpx.AsyncClient(timeout=300.0, verify=_ssl_context())
    return _shared_http_client


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = SONNET_MODEL):
        self.api_key = api_key
        self.model = model
        self.client = _get_shared_client()

    async def complete(
        self,
        system: str,
        user: str,
        max_tokens: int = 4096,
        *,
        cache_user_prefix: str | None = None,
    ) -> str:
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-beta": "prompt-caching-2024-07-31",
            "content-type": "application/json",
        }
        if cache_user_prefix:
            user_content: str | list[dict] = [
                {
                    "type": "text",
                    "text": cache_user_prefix,
                    "cache_control": {"type": "ephemeral"},
                },
                {"type": "text", "text": user},
            ]
        else:
            user_content = user
        response = await self.client.post(
            ANTHROPIC_API_URL,
            headers=headers,
            json={
                "model": self.model,
                "max_tokens": max_tokens,
                "system": [
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                "messages": [{"role": "user", "content": user_content}],
            },
        )
        _raise_for_anthropic(response, model=self.model)
        data = response.json()
        usage = data.get("usage") or {}
        logger.info(
            "anthropic_usage model=%s cache_read=%s cache_creation=%s input=%s output=%s",
            self.model,
            usage.get("cache_read_input_tokens", 0),
            usage.get("cache_creation_input_tokens", 0),
            usage.get("input_tokens", 0),
            usage.get("output_tokens", 0),
        )
        return data["content"][0]["text"]

    async def stream_complete(self, system: str, user: str, max_tokens: int = 4096) -> AsyncIterator[str]:
        """Stream a text response token-by-token."""
        async with self.client.stream(
            "POST",
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "max_tokens": max_tokens,
                "stream": True,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
        ) as response:
            if not response.is_success:
                # Read the full body before translating — it arrived as
                # a streamed response but we don't have a JSON chunk yet
                # for 4xx errors (Anthropic returns one small blob).
                await response.aread()
                _raise_for_anthropic(response, model=self.model)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        yield delta.get("text", "")

    async def complete_with_image(
        self, system: str, text: str, image_b64: str, media_type: str = "image/png", max_tokens: int = 4096
    ) -> str:
        """Send a message with both text and an image (vision)."""
        raw_b64 = _normalize_image_base64(image_b64) or image_b64
        response = await self.client.post(
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": raw_b64,
                                },
                            },
                            {"type": "text", "text": text},
                        ],
                    }
                ],
            },
        )
        _raise_for_anthropic(response, model=self.model)
        data = response.json()
        return data["content"][0]["text"]

    async def stream_complete_with_image(
        self, system: str, text: str, image_b64: str, media_type: str = "image/png", max_tokens: int = 4096
    ) -> AsyncIterator[str]:
        """Stream a vision response token-by-token."""
        raw_b64 = _normalize_image_base64(image_b64) or image_b64
        async with self.client.stream(
            "POST",
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            json={
                "model": self.model,
                "max_tokens": max_tokens,
                "stream": True,
                "system": system,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": raw_b64,
                                },
                            },
                            {"type": "text", "text": text},
                        ],
                    }
                ],
            },
        ) as response:
            if not response.is_success:
                await response.aread()
                _raise_for_anthropic(response, model=self.model)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        yield delta.get("text", "")


OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions"


def _openai_uses_responses_api(slug: str) -> bool:
    """GPT-5+ family is served exclusively through the Responses API on
    most accounts; chat-completions returns "Selected model 'gpt-5-mini'
    is not available" even when the model exists in the catalog. Older
    chat models (gpt-4o, gpt-4.1, etc.) keep using chat-completions.
    """
    if not slug:
        return False
    return slug.startswith("gpt-5") or slug.startswith("o1") or slug.startswith("o3")


class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model
        self.client = _get_shared_client()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _extract_responses_text(data: dict) -> str:
        """Pull text out of a Responses-API JSON envelope."""
        # Convenience aggregate the SDK populates.
        text = data.get("output_text")
        if isinstance(text, str) and text.strip():
            return text
        chunks: list[str] = []
        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "message":
                continue
            for piece in item.get("content") or []:
                if isinstance(piece, dict) and piece.get("type") in (
                    "output_text",
                    "text",
                ):
                    val = piece.get("text") or ""
                    if isinstance(val, str):
                        chunks.append(val)
        return "".join(chunks)

    async def _complete_via_responses(
        self,
        system: str,
        user: str,
        max_tokens: int,
    ) -> str:
        body = {
            "model": self.model,
            "instructions": system,
            "input": user,
            "max_output_tokens": int(max_tokens),
            "stream": False,
            # Batch routes (analyze, assumptions) require parseable JSON;
            # without json_object, GPT-5 via Responses often returns prose.
            "text": {"format": {"type": "json_object"}},
        }
        response = await self.client.post(
            OPENAI_RESPONSES_URL, headers=self._headers(), json=body
        )
        _raise_for_openai(response, model=self.model)
        data = response.json()
        _log_chat_usage("openai", self.model, data.get("usage") or {})
        text = self._extract_responses_text(data)
        if not text:
            raise LLMProviderError(
                502, "OpenAI returned an empty response.", model=self.model
            )
        return text

    async def complete(
        self,
        system: str,
        user: str,
        max_tokens: int = 4096,
        *,
        cache_user_prefix: str | None = None,
    ) -> str:
        # OpenAI doesn't have Anthropic-style ephemeral prompt caching, but
        # callers (analyze_paper, extract_assumptions) pass the real prompt
        # via cache_user_prefix and only a stub via user. If we ignored the
        # prefix the model would receive an empty/whitespace user message
        # and return junk that fails downstream JSON parsing as a 503.
        merged_user = (
            f"{cache_user_prefix}\n\n{user}".strip()
            if cache_user_prefix
            else user
        )
        if _openai_uses_responses_api(self.model):
            return await self._complete_via_responses(system, merged_user, max_tokens)
        body: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": merged_user},
            ],
            "stream": False,
            **_openai_token_fields(self.model, max_tokens),
        }
        if "ONLY valid JSON" in system or "Return ONLY valid JSON" in system:
            body["response_format"] = {"type": "json_object"}
        response = await self.client.post(OPENAI_API_URL, headers=self._headers(), json=body)
        _raise_for_openai(response, model=self.model)
        data = response.json()
        _log_chat_usage("openai", self.model, data.get("usage") or {})
        choices = data.get("choices") or []
        if not choices:
            raise LLMProviderError(502, "OpenAI returned an empty response.", model=self.model)
        content = choices[0].get("message", {}).get("content")
        if not content:
            raise LLMProviderError(502, "OpenAI returned an empty response.", model=self.model)
        return content

    async def stream_complete(self, system: str, user: str, max_tokens: int = 4096) -> AsyncIterator[str]:
        if _openai_uses_responses_api(self.model):
            body = {
                "model": self.model,
                "instructions": system,
                "input": user,
                "max_output_tokens": int(max_tokens),
                "stream": True,
            }
            async with self.client.stream(
                "POST", OPENAI_RESPONSES_URL, headers=self._headers(), json=body
            ) as response:
                if not response.is_success:
                    await response.aread()
                    _raise_for_openai(response, model=self.model)
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload.strip() == "[DONE]":
                        break
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    # Responses-API SSE: response.output_text.delta carries the
                    # incremental text. Some shapes nest it under different keys
                    # depending on the model — handle both.
                    if event.get("type") == "response.output_text.delta":
                        delta = event.get("delta")
                        if isinstance(delta, str) and delta:
                            yield delta
            return
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": True,
            **_openai_token_fields(self.model, max_tokens),
        }
        async with self.client.stream(
            "POST", OPENAI_API_URL, headers=self._headers(), json=body
        ) as response:
            if not response.is_success:
                await response.aread()
                _raise_for_openai(response, model=self.model)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = (event.get("choices") or [{}])[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield content

    async def complete_with_image(
        self, system: str, text: str, image_b64: str, media_type: str = "image/png", max_tokens: int = 4096
    ) -> str:
        raw_b64 = _normalize_image_base64(image_b64) or image_b64
        if _openai_uses_responses_api(self.model):
            body = {
                "model": self.model,
                "instructions": system,
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": text},
                            {
                                "type": "input_image",
                                "image_url": f"data:{media_type};base64,{raw_b64}",
                            },
                        ],
                    }
                ],
                "max_output_tokens": int(max_tokens),
                "stream": False,
            }
            response = await self.client.post(
                OPENAI_RESPONSES_URL, headers=self._headers(), json=body
            )
            _raise_for_openai(response, model=self.model)
            data = response.json()
            _log_chat_usage("openai", self.model, data.get("usage") or {})
            content = self._extract_responses_text(data)
            if not content:
                raise LLMProviderError(
                    502, "OpenAI returned an empty response.", model=self.model
                )
            return content
        user_content = [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{raw_b64}"},
            },
        ]
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            "stream": False,
            **_openai_token_fields(self.model, max_tokens),
        }
        response = await self.client.post(OPENAI_API_URL, headers=self._headers(), json=body)
        _raise_for_openai(response, model=self.model)
        data = response.json()
        _log_chat_usage("openai", self.model, data.get("usage") or {})
        choices = data.get("choices") or []
        if not choices:
            raise LLMProviderError(502, "OpenAI returned an empty response.", model=self.model)
        content = choices[0].get("message", {}).get("content")
        if not content:
            raise LLMProviderError(502, "OpenAI returned an empty response.", model=self.model)
        return content


class MistralProvider(LLMProvider):
    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model
        self.client = _get_shared_client()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def complete(
        self,
        system: str,
        user: str,
        max_tokens: int = 4096,
        *,
        cache_user_prefix: str | None = None,
    ) -> str:
        # Same fix as OpenAI: when callers route the bulk of the prompt
        # through cache_user_prefix (analyze_paper, extract_assumptions),
        # silently dropping it sends an empty user message and the model
        # answers with junk that fails JSON parsing -> 503.
        merged_user = (
            f"{cache_user_prefix}\n\n{user}".strip()
            if cache_user_prefix
            else user
        )
        body: dict = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": merged_user},
            ],
            "stream": False,
        }
        if "ONLY valid JSON" in system or "Return ONLY valid JSON" in system:
            body["response_format"] = {"type": "json_object"}
        response = await self.client.post(MISTRAL_API_URL, headers=self._headers(), json=body)
        _raise_for_mistral(response, model=self.model)
        data = response.json()
        _log_chat_usage("mistral", self.model, data.get("usage") or {})
        choices = data.get("choices") or []
        if not choices:
            raise LLMProviderError(502, "Mistral returned an empty response.", model=self.model)
        content = choices[0].get("message", {}).get("content")
        if not content:
            raise LLMProviderError(502, "Mistral returned an empty response.", model=self.model)
        return content

    async def stream_complete(self, system: str, user: str, max_tokens: int = 4096) -> AsyncIterator[str]:
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": True,
        }
        async with self.client.stream(
            "POST", MISTRAL_API_URL, headers=self._headers(), json=body
        ) as response:
            if not response.is_success:
                await response.aread()
                _raise_for_mistral(response, model=self.model)
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload.strip() == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = (event.get("choices") or [{}])[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    yield content

    async def complete_with_image(
        self, system: str, text: str, image_b64: str, media_type: str = "image/png", max_tokens: int = 4096
    ) -> str:
        raw_b64 = _normalize_image_base64(image_b64) or image_b64
        user_content = [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": f"data:{media_type};base64,{raw_b64}",
            },
        ]
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
            "stream": False,
        }
        if "ONLY valid JSON" in system or "Return ONLY valid JSON" in system:
            body["response_format"] = {"type": "json_object"}
        response = await self.client.post(MISTRAL_API_URL, headers=self._headers(), json=body)
        _raise_for_mistral(response, model=self.model)
        data = response.json()
        _log_chat_usage("mistral", self.model, data.get("usage") or {})
        choices = data.get("choices") or []
        if not choices:
            raise LLMProviderError(502, "Mistral returned an empty response.", model=self.model)
        content = choices[0].get("message", {}).get("content")
        if not content:
            raise LLMProviderError(502, "Mistral returned an empty response.", model=self.model)
        return content


_warned_missing_keys: set[str] = set()


def _provider_for_slug(slug: str) -> str:
    if slug.startswith("claude-"):
        return "anthropic"
    if slug.startswith("gpt-"):
        return "openai"
    if (
        slug.startswith("mistral-")
        or slug.startswith("ministral-")
        or slug.startswith("magistral-")
        or slug.startswith("pixtral-")
    ):
        return "mistral"
    raise LLMProviderError(400, f"Unknown model slug: {slug}", model=slug)


def _require_api_key(provider_name: str) -> str:
    if provider_name == "anthropic":
        key = settings.anthropic_api_key
        env_name = "KNOW_ANTHROPIC_API_KEY"
    elif provider_name == "openai":
        key = settings.openai_api_key
        env_name = "KNOW_OPENAI_API_KEY"
    elif provider_name == "mistral":
        key = settings.mistral_api_key
        env_name = "KNOW_MISTRAL_API_KEY"
    else:
        raise ValueError(f"Unknown provider: {provider_name}")
    if not key:
        if provider_name not in _warned_missing_keys:
            logger.critical(
                "%s is not set — %s-backed LLM calls will fail until configured.",
                env_name,
                provider_name,
            )
            _warned_missing_keys.add(provider_name)
        raise ValueError(f"No API key configured. Set {env_name}.")
    return key


def _make_provider(model: str) -> LLMProvider:
    provider_name = _provider_for_slug(model)
    api_key = _require_api_key(provider_name)
    if provider_name == "openai":
        return OpenAIProvider(api_key, model=model)
    if provider_name == "mistral":
        return MistralProvider(api_key, model=model)
    return AnthropicProvider(api_key, model=model)


# Local-model support (Ollama / OpenAI-compatible local backends) was
# retired in stage 8 of the AI SDK migration. All LLM calls now go
# through Anthropic, OpenAI, or Mistral — optionally fronted by Vercel
# AI Gateway on the Next.js side.


def get_provider(user_id: str | None = None) -> LLMProvider:
    """Get the LLM provider for heavy analysis tasks, enforcing tier model limits."""
    model = settings.analysis_model
    if user_id:
        from ..api.settings import _get_user_model_prefs
        model, _ = _get_user_model_prefs(user_id)
        from ..gating import enforce_model
        model = enforce_model(user_id, model)
    return _make_provider(model)


def get_fast_provider(user_id: str | None = None) -> LLMProvider:
    """Get a faster LLM provider for interactive tasks, enforcing tier model limits."""
    model = settings.fast_model
    if user_id:
        from ..api.settings import _get_user_model_prefs
        _, model = _get_user_model_prefs(user_id)
        from ..gating import enforce_model
        model = enforce_model(user_id, model)
    return _make_provider(model)


def _extract_json(text: str) -> str:
    """Extract JSON from LLM response that may contain markdown code fences."""
    match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if match:
        return match.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1:
        return text[start : end + 1]
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1:
        return text[start : end + 1]
    return text.strip()


def _safe_parse_json(raw: str) -> dict:
    """Extract and parse JSON from LLM output, repairing truncation if needed."""
    cleaned = _extract_json(raw)
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError:
        repaired = cleaned
        if repaired.count('"') % 2 == 1:
            repaired += '"'
        open_braces = repaired.count("{") - repaired.count("}")
        open_brackets = repaired.count("[") - repaired.count("]")
        repaired += "]" * max(0, open_brackets)
        repaired += "}" * max(0, open_braces)
        try:
            result = json.loads(repaired)
        except json.JSONDecodeError:
            return {}
    return _normalize_latex_delimiters(result)


def _repair_orphan_period_display_close(s: str) -> str:
    """GPT often closes display math with `.$$` instead of `$$`."""

    def repl_open(m: re.Match[str]) -> str:
        body = m.group(1).strip()
        if not body or not re.search(
            r"\\(?:sum|binom|frac|prod|int|substack|left|right|mathcal|mathrm)|[_^{}]|\^",
            body,
        ):
            return m.group(0)
        return f"$$\n{body}.\n$$"

    s = re.sub(r"\$\$([\s\S]*?)\.\$\$", repl_open, s)

    def repl_plain(m: re.Match[str]) -> str:
        before, expr = m.group(1), m.group(2).strip()
        if not expr or "$$" in expr:
            return m.group(0)
        if not re.search(
            r"\\(?:sum|binom|frac|prod|int|substack|left|right|mathcal|mathrm)|[_^{}]|\^",
            expr,
        ):
            return m.group(0)
        if not re.search(r"[=+\-*/^]|\\(?:sum|binom|frac)|\([A-Za-z0-9+-]+\)\^", expr):
            return m.group(0)
        return f"{before}\n$$\n{expr}.\n$$"

    # Only apply the bare `(expr).$$` repair outside existing $$…$$ spans.
    parts: list[str] = []
    last = 0
    for m in re.finditer(r"\$\$[\s\S]*?\$\$", s):
        if m.start() > last:
            chunk = s[last : m.start()]
            parts.append(re.sub(r"([^$]|^)([^$\n]{6,}?)\.\$\$", repl_plain, chunk))
        parts.append(m.group(0))
        last = m.end()
    if last < len(s):
        parts.append(re.sub(r"([^$]|^)([^$\n]{6,}?)\.\$\$", repl_plain, s[last:]))
    return "".join(parts) if parts else s


def _repair_comma_display_close(s: str) -> str:
    """GPT sometimes closes `$$…` with `,$$` instead of `$$`."""
    return re.sub(
        r"\$\$([\s\S]*?),(\s*)\$\$(?!\$)",
        lambda m: f"$$\n{m.group(1).strip()},{m.group(2)}\n$$",
        s,
    )


def _normalize_latex_delimiters(obj):
    """Convert \\( \\) to $ and \\[ \\] to $$ in all string values for remark-math compatibility."""
    if isinstance(obj, str):
        s = obj
        s = _repair_orphan_period_display_close(s)
        s = _repair_comma_display_close(s)
        s = re.sub(r'\\\[', '\n$$\n', s)
        s = re.sub(r'\\\]', '\n$$\n', s)
        s = re.sub(r'\\\(', '$', s)
        s = re.sub(r'\\\)', '$', s)
        s = re.sub(r'\n{3,}', '\n\n', s)
        return s
    if isinstance(obj, dict):
        return {k: _normalize_latex_delimiters(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_latex_delimiters(item) for item in obj]
    return obj


def _is_usable_prepare_payload(result: dict) -> bool:
    return bool(
        result.get("definitions")
        or result.get("research_questions")
        or result.get("concepts")
    )


def _try_fence_repair_json(raw: str) -> dict | None:
    s = raw.strip()
    if s.startswith("```"):
        lines = s.split("\n")
        if len(lines) >= 2 and lines[0].startswith("```"):
            if lines[-1].strip() == "```":
                s = "\n".join(lines[1:-1]).strip()
            else:
                s = "\n".join(lines[1:]).strip()
    try:
        parsed = json.loads(s)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# Lightweight metadata extraction (runs during upload, no Haiku needed)
# ---------------------------------------------------------------------------

async def extract_metadata(raw_text: str, user_id: str | None = None) -> dict:
    """Extract just title and authors from raw PDF text using the fast provider."""
    provider = get_fast_provider(user_id)
    snippet = _sanitize_user_text(raw_text, max_chars=3000)
    system = "Extract the paper title and author names from the given text. Return ONLY valid JSON."
    user = f"""Extract the title and authors from this academic paper text.

Return JSON: {{"title": "...", "authors": ["Author One", "Author Two", ...]}}

Text (first 3000 chars):
{snippet}"""

    raw = await provider.complete(system, user, max_tokens=512)
    return _safe_parse_json(raw)


# ---------------------------------------------------------------------------
# Suggested-question generator (Q&A panel "more like these")
# ---------------------------------------------------------------------------

async def suggest_questions(
    paper_text: str,
    *,
    already_seen: list[str] | None = None,
    user_id: str | None = None,
    n: int = 6,
) -> list[str]:
    """Generate ``n`` paper-specific Q&A starter prompts.

    The Q&A tab seeds with a small static list of generic prompts so
    the panel isn't empty on first paint. Once the user has clicked
    through those, this generator takes over: it pulls fresh,
    paper-aware questions from the fast model and avoids repeating
    anything the user has already seen (``already_seen``).

    Returns plain strings — short, action-oriented, one per line — and
    falls back to a small generic list on parse failure so the UI
    never shows an empty suggestion strip.
    """
    provider = get_fast_provider(user_id)
    paper_text = _sanitize_user_text(paper_text, max_chars=8000)
    seen_block = ""
    if already_seen:
        # Bound the exclusion list so a runaway client can't blow out
        # the prompt budget.
        seen = "\n".join(f"- {s}" for s in already_seen[:30])
        seen_block = f"\n\nAlready shown to the user (do NOT repeat these or paraphrase):\n{seen}\n"

    system = (
        "You generate paper-specific questions a curious reader would "
        "ask while studying an academic paper. Output ONLY a JSON "
        "array of strings."
    )
    user = f"""Read the paper excerpt below and produce {n} concise,
specific questions worth asking about it. Each question:
- Is one sentence, ≤ 90 characters.
- Is grounded in something the paper actually says or claims.
- Avoids generic prompts like "what's the main contribution" — the
  user already saw those.
- Reads naturally to a researcher (no LLM-style hedging).
{seen_block}
Paper:
{paper_text[:8000]}

Return JSON: ["question 1", "question 2", ...]
"""
    raw = await provider.complete(system, user, max_tokens=512)
    parsed = _safe_parse_json(raw)
    items: list[str] = []
    if isinstance(parsed, list):
        items = [str(x).strip() for x in parsed if isinstance(x, str)]
    elif isinstance(parsed, dict):
        # Be permissive: some models wrap arrays in an object.
        for v in parsed.values():
            if isinstance(v, list):
                items = [str(x).strip() for x in v if isinstance(x, str)]
                break
    items = [q for q in items if 8 <= len(q) <= 200]
    if not items:
        items = [
            "Which assumption in the paper feels most fragile?",
            "What does the methodology miss?",
            "How would the result change at scale?",
            "What does this paper not say?",
            "What would a skeptical reviewer ask?",
        ]
    return items[:n]


# ---------------------------------------------------------------------------
# Selection-based analysis (triggered by highlighting text in the PDF)
# ---------------------------------------------------------------------------

async def polish_note_from_selection(
    paper_text: str, selected_text: str, user_id: str | None = None,
) -> str:
    """Turn a PDF text-layer excerpt into concise markdown with valid LaTeX.

    Used when the user saves a note from a highlight; the stored note text is
    only this cleaned output (not the raw selection).
    """
    provider = get_fast_provider(user_id)
    selected_text = _sanitize_user_text(selected_text, max_chars=10000)
    paper_text = _sanitize_user_text(paper_text or "", max_chars=5000)

    system = (
        "You convert PDF text-layer excerpts into clear personal study notes.\n"
        "Output markdown only — no preamble, no JSON, and do not wrap the entire answer in a markdown code fence.\n"
        + LATEX_FORMAT_INSTRUCTIONS
        + "\nThe excerpt may be mangled (split lines, wrong Unicode, missing math delimiters). "
        "Use the paper context to infer correct equations and symbol names. "
        "Keep the note compact (a few short paragraphs or bullets unless the excerpt truly needs more).\n"
        "If the excerpt already includes valid Markdown (headings, bullets) or math with $...$ / $$...$$ delimiters, "
        "preserve those delimiters and equations—only fix mangled line breaks or inconsistent math style; do not strip dollar signs.\n"
    )

    user = (
        "Write the note as polished markdown + LaTeX.\n\n"
        f'Excerpt from the PDF text layer:\n"""\n{selected_text}\n"""\n\n'
        f'Nearby paper text for context:\n"""\n{paper_text[:5000]}\n"""'
    )

    raw = await provider.complete(system, user, max_tokens=4096)
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        if len(lines) >= 2 and lines[0].startswith("```"):
            if lines[-1].strip() == "```":
                cleaned = "\n".join(lines[1:-1]).strip()
            else:
                cleaned = "\n".join(lines[1:]).strip()
    return cleaned[:10000]


async def analyze_selection(
    paper_text: str,
    selected_text: str,
    action: str,
    user_id: str | None = None,
    image_b64: str | None = None,
    *,
    model_override: str | None = None,
) -> dict:
    """Analyze a user-highlighted selection from the PDF using the fast provider.

    When ``image_b64`` is provided, the PNG screenshot of the selection is sent
    to a vision-capable model alongside the (probably garbled) text — used for
    equation selections where the PDF text layer is unreadable.

    ``model_override`` is tier-enforced when ``user_id`` is set (Settings pick
    or one-shot override from the client).
    """
    if model_override:
        if user_id:
            from ..gating import enforce_model
            model_override = enforce_model(user_id, model_override)
        provider = _make_provider(model_override)
    else:
        provider = get_fast_provider(user_id)
    budget = get_budgets("selection", user_id)
    selected_text = _sanitize_user_text(selected_text, max_chars=budget["selection"])
    paper_text = _sanitize_user_text(paper_text, max_chars=budget["context"])

    passage_explain_assumptions_json = f"""Explain the following passage from an academic paper clearly and thoroughly.

If the selection looks like a question (ends with a question mark or
otherwise asks something), ANSWER it directly using the paper as
context. If it's a statement, EXPLAIN it: break down every piece of
jargon, clarify the logic step by step, and provide broader context
including implications, connections to other concepts, and why this
matters. Use LaTeX only for actual math ($...$ inline, $$...$$
display).

After the explanation, separately identify assumptions that THIS
SELECTED excerpt explicitly states or unmistakably depends on —
nothing else. Treat "passage-local" narrowly: each assumption must be
something the reader needs to interpret or believe this excerpt, not a
survey of tacit hypotheses from unrelated sections or the overall
study. Prefer a short empty list when there are none. For each entry
give significance (why it matters; what shifts if relaxed).

Selected text:
\"\"\"{selected_text}\"\"\"

Full paper context:
{paper_text[:6000]}

Return JSON:
{{
  "explanation": "thorough markdown explanation OR direct answer. Use LaTeX math only where relevant.",
  "assumptions": [{{"statement": "...", "type": "explicit|implicit", "significance": "..."}}]
}}"""

    action_prompts = {
        # Explain now absorbs the old "question/ask" intent: if the
        # passage *is* a question, treat it as one and answer it; if
        # it's a statement, explain it. Either way the output shape is
        # the same — one rich `explanation` field — which lets the
        # frontend collapse what used to be two separate buttons into
        # one.
        "explain": passage_explain_assumptions_json,

        # Legacy callers may still POST action=assumptions; payloads match Explain.
        "assumptions": passage_explain_assumptions_json,

        # "Derive" used to assume the paper was mathematical. For
        # humanities / literature / qualitative papers that meant
        # forcing equations onto an argument that didn't have any,
        # which read as nonsense. The prompt now explicitly branches:
        # if there's no math, reconstruct the *argumentative*
        # derivation (premise → inference → conclusion) and return
        # natural-language steps — no fabricated equations.
        "derive": f"""Reconstruct the derivation of the result in this passage step-by-step.

DECISION:
- If the passage contains an equation or a quantitative result, derive
  it mathematically: each step has a LaTeX expression and an
  explanation.
- If the paper / passage is non-mathematical (humanities, literature,
  philosophy, history, qualitative social science, etc.), derive the
  ARGUMENT instead: each step is a premise or inference written in
  plain English, leading to the conclusion. Do NOT invent equations.
  Leave LaTeX out of `answer`/`explanation` for these steps unless
  the paper itself uses it.

Either way, fill in any gaps with atomic steps a careful student
would take.

Selected text:
\"\"\"{selected_text}\"\"\"

Full paper context:
{paper_text[:6000]}

Return JSON:
{{
  "title": "Derivation of [specific result or argument]",
  "starting_point": "initial expression OR initial premise",
  "final_result": "target expression OR conclusion",
  "steps": [
    {{
      "step_number": 1,
      "prompt": "what to do or consider in this step",
      "answer": "resulting expression (LaTeX) or stated inference",
      "explanation": "why this step follows",
      "hint": "a helpful nudge"
    }}
  ]
}}""",
    }

    prompt = action_prompts.get(action, action_prompts["explain"])
    system = (
        "You are an expert science educator. Analyze academic paper content to help students learn. "
        "Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    if image_b64 and hasattr(provider, "complete_with_image"):
        # The PDF text layer mangled what's actually on the page — usually
        # an equation. Send the rendered region to a vision-capable model
        # so it can read the LaTeX off the page directly.
        system_vision = (
            system
            + "\n\nIMPORTANT: The image attached is a screenshot of the EXACT selection from "
            "the PDF. It is the ground-truth content the user selected — "
            "the text extraction below may be corrupted or empty. ALWAYS prefer the "
            "image when interpreting equations, symbols, and math. Reconstruct "
            "the LaTeX from the image, then analyze that equation/passage."
        )
        try:
            resized = _resize_image_b64(image_b64)
            raw = await provider.complete_with_image(system_vision, prompt, resized, max_tokens=3000)
        except Exception:
            logger.exception("selection.vision_fallback model=%s", getattr(provider, "model", ""))
            raw = await provider.complete(system, prompt, max_tokens=3000)
    else:
        raw = await provider.complete(system, prompt, max_tokens=3000)
    result = _parse_selection_raw(raw, action)
    result["selected_text"] = selected_text
    result["model"] = provider.model
    if not _selection_has_content(result):
        raise ValueError("Selection returned empty payload")
    return result


def _parse_selection_raw(raw: str, action: str) -> dict:
    """Parse batch selection JSON; accept prose fallback after vision calls."""
    parsed: dict = {}
    if raw and raw.strip().startswith("{"):
        parsed = _safe_parse_json(raw)
    if not isinstance(parsed, dict):
        parsed = {}
    if parsed.get("body") and not parsed.get("explanation"):
        parsed["explanation"] = parsed["body"]
    if action == "explain" or action == "assumptions":
        parsed["action"] = "explain"
    else:
        parsed["action"] = action
    out = _normalize_selection_result(parsed)
    if _selection_has_content(out):
        return out
    text = _coerce_markdown_field(raw).strip()
    if text:
        return _normalize_selection_result(
            {
                "action": action if action != "assumptions" else "explain",
                "explanation": text,
                "steps": [],
            }
        )
    return out


def _sanitize_user_text(text: str, *, max_chars: int = 10000) -> str:
    """Sanitize user-supplied text before embedding in an LLM prompt.

    This is deliberately conservative: the LLM treats the prompt as one big
    string, so a motivated user inserting triple-quote delimiters or
    role-imitation tokens (``Assistant:`` / ``<|im_end|>``) can try to
    break out of the instructions. We can't fully prevent injection inside
    the generated response, but we can:

    - collapse triple-quote delimiters so they can't close our prompt fences
    - strip zero-width / direction-override characters that let attackers
      smuggle instructions past visual review
    - enforce a hard length cap so a single field can't blow out the budget

    The cap is tunable per call site so e.g. paper titles can be bounded
    much tighter than free-form selection text.
    """
    if not isinstance(text, str):
        return ""
    text = text.replace('"""', '""').replace("'''", "''")
    # Drop control / zero-width / bidirectional override characters. We keep
    # \n and \t explicitly; everything else below U+0020 or in the
    # "dangerous" set is stripped.
    banned = {
        "\u200b", "\u200c", "\u200d", "\u200e", "\u200f",
        "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
        "\u2066", "\u2067", "\u2068", "\u2069", "\ufeff",
    }
    out_chars = []
    for ch in text:
        if ch in banned:
            continue
        if ch < " " and ch not in ("\n", "\t"):
            continue
        out_chars.append(ch)
    return "".join(out_chars)[:max_chars]


def _get_selection_prompt(paper_text: str, selected_text: str, action: str) -> tuple[str, str]:
    """Return (system, user_text) for selection analysis with markdown output (for streaming)."""
    selected_text = _sanitize_user_text(selected_text)
    paper_text = _sanitize_user_text(paper_text, max_chars=6000)
    system = (
        "You are an expert science educator. Analyze academic paper content to help students learn. "
        "Use markdown formatting with clear structure. "
        "Do NOT wrap output in JSON or code fences.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
        + "\n\nIMPORTANT: The selected text comes from a PDF text layer. Mathematical equations may appear garbled, "
        "with symbols like subscripts, superscripts, Greek letters, or operators rendered as incorrect Unicode characters "
        "or missing entirely. Layout may look like one character per line or words glued together without spaces — NEVER "
        "preserve that artifact; reconstruct normal flowing prose and cleanly delimited LaTeX. "
        "Use the paper context to infer the correct equations and symbols. "
        "Always reproduce equations correctly in LaTeX even if the selected text is mangled.\n\n"
        "If the selected text is garbled or unintelligible (alphabet soup like 'cv;c0v0 Z c1 v21234c0'), "
        "treat it as a CUE about which equation/passage the user pointed at, NOT as the literal content. "
        "Use the salvageable letters, numbers, and surrounding paper context to identify the exact equation "
        "or passage the user selected, then analyze THAT directly. Do NOT:\n"
        " • apologize that the text is corrupted or unreadable,\n"
        " • quote the garbled string back to the user,\n"
        " • say 'the selected text appears to be...',\n"
        " • discuss multiple possibilities — pick the most likely equation and commit to it.\n"
        "Start your answer immediately with the substantive explanation/derivation as if the user had "
        "selected the equation cleanly."
    )

    passage_explain_stream_md = f"""Explain the following passage from an academic paper clearly and thoroughly.

If the selection looks like a question, ANSWER it directly. If it's a
statement, EXPLAIN it — break down jargon, clarify logic, give context,
implications, and why it matters. Use LaTeX only for real math.
Use markdown formatting.
Note: The selected text is extracted from a PDF text layer and mathematical symbols may be garbled or missing. Interpret them using context.

After that, append a markdown section titled exactly **## Passage-local assumptions**
with bullet points grouped under **Explicit** and **Implicit** only for
premises THIS excerpt states or unmistakably depends on to interpret
that excerpt. Stay narrow: do not inventory assumptions for unrelated
sections or the whole paper. If there are none, write "*(None obvious
beyond ordinary reading.)"* under that heading.

Selected text:
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}"""

    prompts = {
        # Explain folds in the old "Ask" button: if the selected text
        # ends like a question, answer it directly; otherwise explain
        # the passage. Same prompt shape either way.
        "explain": passage_explain_stream_md,

        # Legacy callers that still request streaming "assumptions" get the unified explain flow.
        "assumptions": passage_explain_stream_md,

        "derive": f"""Reconstruct the derivation in this passage step-by-step.

If the paper / passage is mathematical, derive it mathematically with
LaTeX expressions per step. If the paper is non-mathematical
(humanities, literature, philosophy, history, qualitative
social science, etc.), derive the *argument* instead: each step a
premise or inference in plain English, leading to the conclusion.
Do NOT fabricate equations for non-mathematical content.

Use markdown formatting with numbered steps.
Note: Math in the selection may be garbled from PDF extraction. Reconstruct equations using paper context when applicable.

Selected text:
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}""",

        # `followup` is reached when the user types into the inline
        # follow-up box on a previous selection card. The "selection"
        # field is the user's question; the original analysed passage
        # plus its result is included in the body of the prompt by the
        # caller.
        "followup": f"""You are continuing a conversation about an academic paper.

Below is the user's earlier-analysed passage and what was said about
it, followed by their follow-up question. Answer the follow-up clearly
and concretely, citing the passage where useful. Use markdown and
LaTeX (only when actual math is involved).

Earlier passage + analysis (verbatim):
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}""",
    }

    return system, prompts.get(action, prompts["explain"])


# ---------------------------------------------------------------------------
# Analysis functions (use Sonnet or user-configured provider)
# ---------------------------------------------------------------------------

def _build_prepare_user_prompt(
    paper_text: str,
    bib_for_prompt: str,
    *,
    simplified: bool = False,
) -> str:
    if simplified:
        return f"""Analyze this paper and return ONLY a JSON object with:
1. "definitions": array of {{"term": "...", "definition": "...", "source": "..."}} (at least 2 if possible)
2. "research_questions": array of {{"question": "...", "context": "..."}} (at least 1)
3. "concepts": array of {{"name": "...", "description": "...", "importance": "..."}} (at least 2)
4. "reference_summaries": []
5. "reference_clusters": []
6. "prior_work_topics": []
7. "prior_work": []

Paper body:
{paper_text}
"""
    return f"""Analyze this paper and return a JSON object with these fields:

1. "definitions": array of {{"term": "...", "definition": "...", "source": "..."}} — key technical terms. Use LaTeX in strings as needed ($...$ / $$...$$).
2. "research_questions": array of {{"question": "...", "context": "..."}}.
3. "concepts": array of {{"name": "...", "description": "...", "importance": "..."}} — key concepts.

4. "reference_summaries": array explaining bibliography entries cited in THIS paper — REQUIRED whenever the REFERENCE excerpt below lists numbered references.
   Each element MUST be {{ "bib_label": "either one index ('17') or an inclusive hyphen span ('1-3') when the manuscript cites that range literally", "relevance": "one sentence on how THIS manuscript uses that source"}}.
   - **relevance** must describe usage inside THIS manuscript (compare to prior experiments, methodological debt, motivational context …). NEVER repeat or paraphrase the bibliography entry as its own headline or title—the product UI already renders the verbatim reference line extracted from the PDF.
   - When two indices need materially different wording, emit separate summaries instead of spanning them if possible.
   - If the bibliography excerpt is missing/unusable below, output [] instead.

5. "reference_clusters" (optional array): cluster bibliography indices by shared idea or where they enter the argument.
   Each element MUST be {{
     "theme": "optional short internal label (not shown in the References UI)",
     "summary": "REQUIRED one sentence when you include this cluster—ties the grouped citations together for THIS paper (this paragraph appears above the verbatim bibliography bullets).",
     "bib_labels": ["2","7","14"]
   }}
   Rules:
   - bib_labels may be discrete indices ('7','21') OR a single inclusive hyphen span ('11-13'); downstream code expands spans to individual bibliography lines.
   - Each bibliography number appears AT MOST ONCE across all clusters (first cluster wins conceptually — avoid duplicates entirely).
   - Any bibliography numbers you omit remain listed by the UI under \"Other references\" (no summary paragraph there—only verbatim citation bullets).
   - If grouping is unreliable, output [] and the UI shows a flat bullet list of every bibliography line (no cluster prose).

6. "prior_work_topics": ALWAYS output [] — the bibliography path builds everything server-side.

7. "prior_work": always [] — the server builds bibliography rows locally and merges your summaries + clusters above.

Paper body (truncated):
{paper_text}

REFERENCE LIST excerpt (ground truth for citations — use for matching titles and DOIs):
{bib_for_prompt if bib_for_prompt else "(no isolated reference block detected — infer carefully from the body above)"}
"""


async def analyze_paper(paper_text: str, user_id: str | None = None) -> dict:
    """Run pre-reading analysis on paper content."""
    provider = get_provider(user_id)
    model_slug = getattr(provider, "model", "unknown")
    paper_text_full = _sanitize_user_text(paper_text, max_chars=200_000)
    paper_text = build_prepare_excerpt(paper_text_full, max_chars=12000)

    bib_excerpt = extract_references_section(paper_text_full, max_chars=10000)
    bib_for_prompt = bib_excerpt[-8000:] if len(bib_excerpt) > 8000 else bib_excerpt

    system = (
        "You are an expert science educator. Analyze the given academic paper and extract structured information "
        "to help a student prepare before reading. Return ONLY valid JSON with no other text.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    user = _build_prepare_user_prompt(paper_text, bib_for_prompt, simplified=False)

    async def _run(user_prompt: str, max_tokens: int) -> str:
        return await provider.complete(
            system,
            "\n",
            max_tokens=max_tokens,
            cache_user_prefix=user_prompt,
        )

    raw = await _run(user, 10000)
    result = _safe_parse_json(raw)
    if _is_usable_prepare_payload(result):
        return result

    repaired = _try_fence_repair_json(raw)
    if repaired:
        repaired = _normalize_latex_delimiters(repaired)
        if _is_usable_prepare_payload(repaired):
            return repaired

    logger.warning(
        "Prepare retry model=%s raw_len=%s",
        model_slug,
        len(raw),
    )
    retry_user = _build_prepare_user_prompt(paper_text, "", simplified=True)
    raw_retry = await _run(retry_user, 6000)
    result = _safe_parse_json(raw_retry)
    if _is_usable_prepare_payload(result):
        return result

    repaired = _try_fence_repair_json(raw_retry)
    if repaired:
        repaired = _normalize_latex_delimiters(repaired)
        if _is_usable_prepare_payload(repaired):
            return repaired

    if len(raw.strip()) < 200 and len(raw_retry.strip()) < 200:
        logger.warning(
            "Prepare empty payload model=%s raw=%s",
            model_slug,
            raw.strip()[:200],
        )
        raise ValueError("Prepare returned empty payload")

    logger.warning(
        "Prepare unusable JSON model=%s raw_len=%s retry_len=%s",
        model_slug,
        len(raw),
        len(raw_retry),
    )
    raise ValueError("Prepare returned empty payload")


async def explain_term(paper_text: str, term: str, context: str, user_id: str | None = None) -> dict:
    """Explain a term in the context of the paper."""
    provider = get_provider(user_id)
    term = _sanitize_user_text(term, max_chars=500)
    context = _sanitize_user_text(context, max_chars=5000)
    paper_text = _sanitize_user_text(paper_text, max_chars=10000)

    system = (
        "You are an expert science educator. Explain technical terms clearly and accurately. "
        "Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    user = f"""Given this paper context, explain the term "{term}".

Additional context from the user: {context}

First check if the term is defined in the paper. Then provide a clear explanation.
Use LaTeX notation for any math (e.g., $\\nabla \\cdot E = \\rho / \\epsilon_0$).

Return JSON: {{"term": "...", "explanation": "...", "source": "name of source if from another paper", "in_paper": true/false}}

Paper excerpt:
{paper_text[:10000]}"""

    raw = await provider.complete(system, user, max_tokens=3000)
    return _safe_parse_json(raw)


async def find_skipped_steps(paper_text: str, section: str, user_id: str | None = None) -> dict:
    """Identify and fill in skipped derivation steps."""
    provider = get_provider(user_id)
    section = _sanitize_user_text(section, max_chars=10000)
    paper_text = _sanitize_user_text(paper_text, max_chars=10000)

    system = (
        "You are an expert physicist and mathematics educator. When given a derivation from a paper, "
        "identify any steps that were skipped and provide the intermediate steps. Return ONLY valid JSON.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    user = f"""Analyze this section from a paper and identify any skipped steps in derivations.

Section: {section}

Full paper context:
{paper_text[:10000]}

Return JSON:
{{
  "section": "section name",
  "original_derivation": "brief description",
  "filled_steps": [
    {{
      "step_number": 1,
      "expression": "the mathematical expression (use LaTeX like $...$)",
      "explanation": "why this step follows from the previous",
      "hint": "a hint for someone trying to derive this themselves"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=3000)
    return _safe_parse_json(raw)


def _coerce_markdown_field(value: object) -> str:
    """Coerce LLM JSON fields to plain strings (Mistral sometimes nests prose)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n\n".join(_coerce_markdown_field(v) for v in value if v is not None).strip()
    if isinstance(value, dict):
        for key in ("text", "content", "markdown", "body", "explanation", "answer"):
            if key in value:
                return _coerce_markdown_field(value[key])
        return ""
    return str(value)


def _normalize_selection_result(result: dict) -> dict:
    """Ensure selection payloads are safe for the TS client (string fields only)."""
    out = dict(result)
    for key in (
        "explanation",
        "elaboration",
        "answer",
        "title",
        "starting_point",
        "final_result",
    ):
        if key in out:
            out[key] = _coerce_markdown_field(out.get(key))
    if "assumptions" in out:
        items = out.get("assumptions")
        if isinstance(items, list):
            norm_assumptions = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                statement = _coerce_markdown_field(item.get("statement")).strip()
                if not statement:
                    continue
                type_val = _coerce_markdown_field(item.get("type")).strip().lower()
                if type_val not in ("explicit", "implicit"):
                    type_val = "implicit"
                norm_assumptions.append(
                    {
                        "statement": statement,
                        "type": type_val,
                        "significance": _coerce_markdown_field(item.get("significance")),
                    }
                )
            out["assumptions"] = norm_assumptions
    if not out.get("steps") and out.get("derivation_steps"):
        out["steps"] = out["derivation_steps"]

    raw_steps = out.get("steps")
    if isinstance(raw_steps, list):
        norm_steps = []
        for step in raw_steps:
            if not isinstance(step, dict):
                continue
            sn = step.get("step_number")
            if isinstance(sn, str) and sn.isdigit():
                sn = int(sn)
            elif not isinstance(sn, int):
                sn = len(norm_steps) + 1
            norm_steps.append(
                {
                    "step_number": sn,
                    "prompt": _coerce_markdown_field(step.get("prompt")),
                    "answer": _coerce_markdown_field(
                        step.get("answer") or step.get("expression") or step.get("result")
                    ),
                    "explanation": _coerce_markdown_field(step.get("explanation")),
                    "hint": _coerce_markdown_field(step.get("hint")),
                }
            )
        out["steps"] = norm_steps

    if not _coerce_markdown_field(out.get("explanation")).strip():
        steps = out.get("steps")
        if isinstance(steps, list) and steps:
            parts: list[str] = []
            title = _coerce_markdown_field(out.get("title")).strip()
            if title:
                parts.append(f"## {title}")
            sp = _coerce_markdown_field(out.get("starting_point")).strip()
            if sp:
                parts.append(f"**Starting point:** {sp}")
            for step in steps:
                if not isinstance(step, dict):
                    continue
                n = step.get("step_number") or 0
                ans = _coerce_markdown_field(step.get("answer"))
                expl = _coerce_markdown_field(step.get("explanation"))
                block = f"**Step {n}:** {ans}".strip()
                if expl:
                    block = f"{block}\n\n{expl}".strip()
                if block.replace("*", "").strip():
                    parts.append(block)
            fr = _coerce_markdown_field(out.get("final_result")).strip()
            if fr:
                parts.append(f"**Result:** {fr}")
            if parts:
                out["explanation"] = "\n\n".join(parts)
    return out


def _selection_has_content(result: dict) -> bool:
    if _coerce_markdown_field(result.get("explanation")).strip():
        return True
    steps = result.get("steps")
    if isinstance(steps, list) and len(steps) > 0:
        return True
    if _coerce_markdown_field(result.get("final_result")).strip():
        return True
    if _coerce_markdown_field(result.get("starting_point")).strip():
        return True
    if isinstance(result.get("assumptions"), list) and len(result["assumptions"]) > 0:
        return True
    return False


def _coerce_assumptions(raw_items: object) -> list[dict]:
    """Normalize LLM assumption rows; drop empty or malformed entries."""
    if not isinstance(raw_items, list):
        return []
    out: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        statement = str(item.get("statement") or "").strip()
        if not statement:
            continue
        type_val = str(item.get("type") or "implicit").strip().lower()
        if type_val not in ("explicit", "implicit"):
            type_val = "implicit"
        section = str(item.get("section") or "").strip()
        out.append({"statement": statement, "type": type_val, "section": section})
    return out


async def extract_assumptions(paper_text: str, user_id: str | None = None) -> dict:
    """Extract explicit and implicit assumptions."""
    provider = get_provider(user_id)
    paper_text = _sanitize_user_text(paper_text, max_chars=get_budgets("assumptions", user_id)["context"])

    system = (
        "You are an expert science educator. Identify all assumptions in the paper, both those explicitly "
        "stated and those implied. Return ONLY valid JSON with no markdown fences.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    paper_block = f"Paper content:\n{paper_text[:6000]}"
    task = """Analyze this paper and extract all assumptions, both explicit (clearly stated) and implicit (unstated but necessary for the conclusions to hold).

Return JSON:
{
  "assumptions": [
    {
      "statement": "the assumption",
      "type": "explicit" or "implicit",
      "section": "which section this relates to"
    }
  ]
}

Include at least 3 assumptions when the paper has substantive claims."""

    raw = await provider.complete(
        system,
        task,
        max_tokens=8192,
        cache_user_prefix=paper_block,
    )
    items = _coerce_assumptions(_safe_parse_json(raw).get("assumptions"))
    if items:
        return {"assumptions": items}

    # One retry with a stricter, shorter instruction when the model returns
    # malformed JSON or an empty list — common on first pass after upload.
    retry_task = (
        task
        + "\n\nYour previous response was not usable. Return ONLY the JSON object "
        "above with a non-empty assumptions array."
    )
    raw_retry = await provider.complete(
        system,
        retry_task,
        max_tokens=8192,
        cache_user_prefix=paper_block,
    )
    items = _coerce_assumptions(_safe_parse_json(raw_retry).get("assumptions"))
    return {"assumptions": items}


async def generate_derivation_exercise(paper_text: str, section: str, user_id: str | None = None) -> dict:
    """Generate an interactive derivation exercise with fill-in-the-blank steps."""
    provider = get_provider(user_id)
    section = _sanitize_user_text(section, max_chars=10000)
    paper_text = _sanitize_user_text(paper_text, max_chars=6000)

    system = (
        "You are an expert physics/mathematics educator creating interactive derivation exercises. "
        "Your exercises must be detailed, pedagogical, and genuinely useful for a student trying to learn "
        "the material. Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    user = f"""Create a thorough step-by-step derivation exercise based on the section titled "{section}" from this paper.

CRITICAL INSTRUCTIONS:
- Find the key derivation or mathematical argument in this section
- Break it into 6-12 ATOMIC steps where each step involves exactly one algebraic manipulation, substitution, or logical move
- Each step MUST have:
  * "prompt": A clear instruction telling the student what to do
  * "answer": The resulting mathematical expression after performing the step (use LaTeX like $...$)
  * "explanation": WHY this step works and what principle it uses (2-3 sentences)
  * "hint": A gentle nudge without giving away the answer
- Start from a clearly stated starting equation/expression
- End at the final result from the paper

Full paper context:
{paper_text[:6000]}

Return JSON:
{{
  "title": "Derivation of [specific result]",
  "original_section": "{section}",
  "starting_point": "The equation or expression we begin from (in LaTeX)",
  "final_result": "The target equation we are deriving (in LaTeX)",
  "steps": [
    {{
      "step_number": 1,
      "prompt": "clear instruction of what the student should do",
      "answer": "the resulting expression after this step (LaTeX)",
      "explanation": "detailed explanation of what happened and why",
      "hint": "a helpful hint without giving away the answer"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    return _safe_parse_json(raw)


async def answer_questions(
    paper_text: str,
    questions: list[str],
    user_id: str | None = None,
    paper_id: str | None = None,
) -> list[dict]:
    """Answer a batch of questions about the paper."""
    provider = get_provider(user_id)
    budget = get_budgets("qa", user_id)
    ctx_cap = budget["context"]
    questions = [_sanitize_user_text(q, max_chars=2000) for q in questions]

    context_block = ""
    retrieval_hits: list[dict] = []
    if paper_id:
        try:
            from .retrieval import retrieve_for_paper
            context_block, retrieval_hits = await retrieve_for_paper(
                [paper_id], " ".join(questions), user_id=user_id or "", max_chars=ctx_cap,
            )
        except Exception:
            pass
    if not context_block:
        paper_text = _sanitize_user_text(paper_text, max_chars=ctx_cap)
        context_block = paper_text[:ctx_cap]

    system = (
        "You are an expert science educator. Answer each question helpfully whether or not every detail appears in "
        "the manuscript. When relevant, ground claims in this paper's text, methods, or results and indicate that basis. "
        "If the PDF does not address the topic—or does so only indirectly—say so briefly, then answer using reliable "
        "general knowledge clearly labeled as such, and propose concrete Google Scholar-style search phrases or keywords "
        "the reader could try next. Do not refuse solely because wording is absent from the excerpts. "
        "Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    q_list = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))

    user = f"""Answer these questions.

Prioritize citing or paraphrasing the paper below when it is on-point. When the paper is insufficient, unclear, or the question asks for background, definitions, comparisons, or context beyond this PDF, complement with general-domain knowledge you can stand behind—and state when you are drawing on that rather than the manuscript. Include suggested search queries when extra retrieval would materially help.

Questions:
{q_list}

Paper text (possibly truncated excerpts):
{context_block}

Return JSON:
{{
  "items": [
    {{
      "question": "the original question",
      "answer": "paper-grounded summary when relevant; labeled general background when useful; Scholar-style queries if more sources help; LaTeX for math (e.g., $E = mc^2$)"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    parsed = _safe_parse_json(raw)
    # Stamp retrieval hits on each item so the UI can render "Show passage"
    # chips. The model didn't pick per-question hits — Track D retrieves once
    # for the whole batch — so each answer carries the same set. A future
    # iteration can re-rank per-question if needed.
    if isinstance(parsed, dict) and isinstance(parsed.get("items"), list) and retrieval_hits:
        for item in parsed["items"]:
            if isinstance(item, dict):
                item["sources"] = retrieval_hits
    return parsed


MULTI_QA_TOTAL_CHAR_BUDGET = 30_000


async def answer_questions_multi(
    paper_texts: list[tuple[str, str]],
    questions: list[str],
    user_id: str | None = None,
    paper_ids: list[str] | None = None,
) -> list[dict]:
    """Answer questions using context from multiple papers.
    paper_texts: list of (title, raw_text) tuples.

    The total context is capped at ``MULTI_QA_TOTAL_CHAR_BUDGET`` so a
    workspace with many large papers can't produce a multi-megabyte prompt
    (and the corresponding Anthropic bill). Each paper gets an equal share
    of the budget, with at least 2k chars each and a floor of 1 paper.
    """
    provider = get_provider(user_id)
    budget = get_budgets("qa", user_id)
    questions = [_sanitize_user_text(q, max_chars=2000) for q in questions]

    system = (
        "You are an expert science educator. You have access to multiple papers in a reading session. "
        "Synthesize what the provided PDFs support when relevant. If a question is not fully covered in these texts, "
        "say so briefly, then answer with well-scoped general knowledge (clearly distinguished) and suggest search "
        "queries or follow-up reading. Do not refuse solely because a fact is missing from the excerpts. "
        "Reference specific papers by title when citing them. Return ONLY valid JSON.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    q_list = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))

    papers_context = ""
    n_papers = max(1, len(paper_texts))
    chars_per_paper = max(2000, MULTI_QA_TOTAL_CHAR_BUDGET // n_papers)
    query_text = " ".join(questions)
    all_hits: list[dict] = []
    for i, (title, text) in enumerate(paper_texts):
        safe_title = _sanitize_user_text(title or "", max_chars=200)
        safe_text = ""
        pid = (paper_ids[i] if paper_ids and i < len(paper_ids) else None)
        if pid:
            try:
                from .retrieval import retrieve_for_paper
                retrieved, hits = await retrieve_for_paper(
                    [pid], query_text, user_id=user_id or "", max_chars=chars_per_paper,
                )
                if retrieved:
                    safe_text = retrieved
                if hits:
                    all_hits.extend(hits)
            except Exception:
                pass
        if not safe_text:
            safe_text = _sanitize_user_text(text or "", max_chars=chars_per_paper)
        papers_context += f"\n--- Paper {i+1}: {safe_title} ---\n{safe_text}\n"

    user = f"""Answer these questions. Use synthesis across papers when helpful. When the session materials are silent or incomplete on a point, note the gap, answer with labeled general knowledge where appropriate, and suggest search phrases or papers to look up.

Questions:
{q_list}

{papers_context}

Return JSON:
{{
  "items": [
    {{
      "question": "the original question",
      "answer": "synthesize across papers when apt; cite by title where specific; labeled general knowledge gap-fills; search phrases when materials are thin; LaTeX for math"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    parsed = _safe_parse_json(raw)
    # Stamp the union of per-paper retrieval hits on every answer. Cross-paper
    # answers don't have a 1:1 mapping between question and source paper, so
    # we let the UI render every retrieved chunk and group by paper id there.
    if isinstance(parsed, dict) and isinstance(parsed.get("items"), list) and all_hits:
        for item in parsed["items"]:
            if isinstance(item, dict):
                item["sources"] = all_hits
    return parsed


async def summarize_paper_lite(
    paper_text: str,
    model_override: str | None = None,
    user_id: str | None = None,
) -> dict:
    """Fast first-impression summary (overview + bullets + a few equations)."""
    if model_override:
        if user_id:
            from ..gating import enforce_model
            model_override = enforce_model(user_id, model_override)
        provider = _make_provider(model_override)
    else:
        provider = get_fast_provider(user_id)

    cap = min(get_budgets("summary", user_id)["context"], 6000)
    paper_text = _sanitize_user_text(paper_text, max_chars=cap)

    system = (
        "You are an expert science editor. Return ONLY valid JSON with no markdown fences.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )
    user = f"""Summarize this paper's first impression in JSON only:
{{
  "overview": "3-5 sentences",
  "tl_dr": "one sentence takeaway",
  "key_contributions": ["3-5 short bullets"],
  "key_equations": [{{"equation": "$$...$$", "meaning": "one paragraph"}}]
}}

Keep the response compact. At most 3 key_equations. Paper excerpt:
{paper_text[:cap]}"""

    raw = await provider.complete(system, user, max_tokens=2000)
    parsed = _safe_parse_json(raw)
    overview = _coerce_markdown_field(parsed.get("overview")).strip()
    if not overview:
        raise ValueError("Lite summary returned empty overview")
    parsed["overview"] = overview
    if "tl_dr" in parsed:
        parsed["tl_dr"] = _coerce_markdown_field(parsed.get("tl_dr"))
    if isinstance(parsed.get("key_contributions"), list):
        parsed["key_contributions"] = [
            _coerce_markdown_field(x).strip()
            for x in parsed["key_contributions"]
            if _coerce_markdown_field(x).strip()
        ]
    parsed["model"] = provider.model
    return parsed


async def summarize_paper_deep(
    paper_text: str,
    model_override: str | None = None,
    user_id: str | None = None,
) -> dict:
    """Deep summary body (methodology, results, discussion, etc.)."""
    if model_override:
        if user_id:
            from ..gating import enforce_model
            model_override = enforce_model(user_id, model_override)
        provider = _make_provider(model_override)
    else:
        provider = get_provider(user_id)

    cap = min(get_budgets("summary", user_id)["context"], 6000)
    paper_text = _sanitize_user_text(paper_text, max_chars=cap)

    system = (
        "You are an expert science editor. Return ONLY valid JSON with no markdown fences.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )
    user = f"""Write the detailed body of an academic paper summary in JSON only:
{{
  "motivation": "3-5 sentences",
  "methodology": "1-2 paragraphs",
  "main_results": "1-2 paragraphs",
  "discussion": "1-2 paragraphs",
  "limitations": ["short bullets"],
  "future_work": "2-3 sentences",
  "key_figures_and_tables": [{{"id": "Fig. 1", "description": "..."}}]
}}

Always include non-empty methodology, main_results, and discussion. Paper excerpt:
{paper_text[:cap]}"""

    raw = await provider.complete(system, user, max_tokens=3500)
    parsed = _safe_parse_json(raw)
    for key in ("motivation", "methodology", "main_results", "discussion", "future_work"):
        if key in parsed:
            parsed[key] = _coerce_markdown_field(parsed.get(key))
    if isinstance(parsed.get("limitations"), list):
        parsed["limitations"] = [
            _coerce_markdown_field(x).strip()
            for x in parsed["limitations"]
            if _coerce_markdown_field(x).strip()
        ]
    methodology = _coerce_markdown_field(parsed.get("methodology")).strip()
    if not methodology:
        raise ValueError("Deep summary returned empty methodology")
    parsed["methodology"] = methodology
    parsed["model"] = provider.model
    return parsed


async def summarize_paper(paper_text: str, model_override: str | None = None, user_id: str | None = None) -> dict:
    """Generate an extremely detailed, structured summary of the paper."""
    if model_override:
        if user_id:
            from ..gating import enforce_model
            model_override = enforce_model(user_id, model_override)
        provider = _make_provider(model_override)
    else:
        provider = get_provider(user_id)

    paper_text = _sanitize_user_text(paper_text, max_chars=get_budgets("summary", user_id)["context"])

    system = (
        "You are an expert science educator and researcher. Produce an extremely detailed, structured summary "
        "of the academic paper. Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    user = f"""Create an extremely detailed summary of this academic paper. The summary should be comprehensive enough that someone could understand the paper's full contribution without reading the original.

Structure your summary with ALL of the following sections:

1. **overview**: A 3-5 sentence high-level overview of what the paper does and why it matters.
2. **motivation**: Why was this work done? What gap in knowledge does it fill? (3-5 sentences)
3. **key_contributions**: Array of the paper's main contributions (each as a string, 1-2 sentences).
4. **methodology**: Detailed explanation of the methods, models, or theoretical framework used. Include equations where relevant. (Multiple paragraphs)
5. **main_results**: Detailed description of the key findings, including quantitative results. Use LaTeX for any numbers or equations. (Multiple paragraphs)
6. **discussion**: What do the results mean? How do they compare to prior work? What are the implications? (Multiple paragraphs)
7. **limitations**: Array of limitations or caveats the authors mention or that are apparent.
8. **future_work**: What follow-up research does this enable or suggest? (2-3 sentences)
9. **key_equations**: Array of the most important equations in the paper, each as {{"equation": "LaTeX", "meaning": "what it represents"}}.
10. **key_figures_and_tables**: Array of descriptions of the most important figures/tables: {{"id": "Fig. 1", "description": "what it shows and why it matters"}}.

Paper content:
{paper_text[: get_budgets("summary", user_id)["context"]]}

Return JSON with all the above fields."""

    raw = await provider.complete(system, user, max_tokens=6000)
    return _safe_parse_json(raw)


def _normalize_image_base64(image_b64: str | None) -> str | None:
    """Return raw base64 payload without a data-URL prefix."""
    if not isinstance(image_b64, str):
        return None
    s = image_b64.strip()
    if not s:
        return None
    # Clients may send `data:image/png;base64,XXXX`. Providers re-wrap with
    # their own prefix — strip first to avoid `data:...;base64,data:...`.
    if s.startswith("data:"):
        comma = s.find(",")
        if comma >= 0:
            s = s[comma + 1 :].strip()
    if len(s) > 6_500_000:
        return None
    return s or None


def _resize_image_b64(image_b64: str, max_dim: int = MAX_IMAGE_DIMENSION) -> str:
    """Downscale a base64 PNG if either dimension exceeds max_dim. Uses PyMuPDF."""
    import base64
    import fitz

    normalized = _normalize_image_base64(image_b64)
    if not normalized:
        return image_b64

    try:
        raw = base64.b64decode(normalized)
        pix = fitz.Pixmap(raw)
        w, h = pix.width, pix.height
        if w <= max_dim and h <= max_dim:
            return normalized

        scale = max_dim / max(w, h)
        new_w, new_h = int(w * scale), int(h * scale)

        doc = fitz.open()
        try:
            page = doc.new_page(width=new_w, height=new_h)
            page.insert_image(fitz.Rect(0, 0, new_w, new_h), pixmap=pix)
            out_pix = page.get_pixmap(dpi=72)
        finally:
            doc.close()

        return base64.b64encode(out_pix.tobytes("png")).decode("utf-8")
    except Exception:
        return normalized


async def analyze_figure(
    paper_text: str,
    image_b64: str,
    question: str = "",
    user_id: str | None = None,
    paper_id: str | None = None,
) -> dict:
    """Analyze a figure from the paper using a vision-capable model."""
    provider = get_fast_provider(user_id)
    if not hasattr(provider, "complete_with_image"):
        raise ValueError("Figure analysis requires a provider with vision support.")

    image_b64 = _resize_image_b64(image_b64)
    ctx_cap = get_budgets("figure", user_id)["context"]
    context_block = ""
    if paper_id:
        try:
            from .retrieval import retrieve_for_paper
            q = question or "figure methods results"
            context_block, _ = await retrieve_for_paper(
                [paper_id], q, user_id=user_id or "", max_chars=ctx_cap,
            )
        except Exception:
            pass
    if not context_block:
        context_block = _sanitize_user_text(paper_text, max_chars=ctx_cap)[:ctx_cap]
    question = _sanitize_user_text(question, max_chars=2000)

    system = (
        "You are an expert science educator analyzing figures from academic papers. "
        "Provide clear, thorough, educational explanations. Return ONLY valid JSON.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    if question.strip():
        user_text = f"""The user has a question about this figure from an academic paper.

User's question: {question}

Paper context (for reference):
{context_block}

Analyze the figure and answer the question thoroughly.

Return JSON:
{{
  "description": "brief description of what the figure shows",
  "answer": "thorough answer to the user's question",
  "key_observations": ["observation 1", "observation 2"],
  "relation_to_paper": "how this figure relates to the paper"
}}"""
    else:
        user_text = f"""Analyze this figure from an academic paper in detail.

Paper context (for reference):
{context_block}

Describe what the figure shows, what the axes/labels mean, and how it relates to the paper.

Return JSON:
{{
  "description": "detailed description of what the figure shows",
  "key_observations": ["observation 1", "observation 2"],
  "methodology_shown": "what method this figure illustrates (if applicable)",
  "relation_to_paper": "how this figure supports the paper's arguments",
  "takeaway": "the main conclusion from this figure"
}}"""

    raw = await provider.complete_with_image(system, user_text, image_b64, max_tokens=4000)
    parsed = _safe_parse_json(raw)
    usable = bool(
        (parsed or {}).get("description")
        or (parsed or {}).get("answer")
        or (parsed or {}).get("takeaway")
    )
    if not usable:
        # Retry once with an explicit "JSON only, no prose" reminder. This
        # rescues Mistral / OpenAI vision responses that mixed prose into
        # the answer or returned an incomplete first attempt.
        retry_text = (
            user_text
            + "\n\nReturn ONLY the JSON object described above. "
              "Do not wrap it in markdown fences. Do not include any prose "
              "outside the JSON. Every required field MUST be present and non-empty."
        )
        raw_retry = await provider.complete_with_image(
            system, retry_text, image_b64, max_tokens=4000,
        )
        parsed_retry = _safe_parse_json(raw_retry)
        if (
            (parsed_retry or {}).get("description")
            or (parsed_retry or {}).get("answer")
            or (parsed_retry or {}).get("takeaway")
        ):
            parsed = parsed_retry
        else:
            # Both attempts failed structured-output. Salvage whatever
            # prose the model emitted so the user still sees a useful
            # description rather than "no content". This matches how
            # selection / explain handle Mistral fallbacks: prose-as-
            # description, with a flag so the renderer can label it.
            fallback_text = (raw_retry or raw or "").strip()
            if fallback_text:
                parsed = {
                    "description": fallback_text[:4000],
                    "key_observations": [],
                    "relation_to_paper": "",
                    "answer": fallback_text[:4000] if question.strip() else "",
                }
    return parsed


PODCAST_FORBIDDEN = [
    "yeah", "right?", "so...", "basically", "honestly", "totally",
    "kind of", "you know", "let's dive in", "deep dive", "wow",
]


async def generate_podcast_script(
    paper,
    sections: list[str],
    *,
    target_minutes: int = 8,
    user_id: str | None = None,
    cache: dict | None = None,
) -> tuple[list[dict], dict]:
    """Generate segmented podcast script JSON. Returns (segments, meta)."""
    from .paper_excerpt import build_prepare_excerpt
    from .exports.podcast_render import validate_podcast_script

    provider = get_provider(user_id)
    target_words = target_minutes * 150
    from .pdf_parser import paper_prompt_text

    paper_text = build_prepare_excerpt(paper_prompt_text(paper), max_chars=6000)

    section_blocks = []
    content = cache or {}
    for key in sections:
        from .exports.podcast_render import build_section_text

        text = build_section_text(key, {}, content)
        if text.strip():
            section_blocks.append(f"[{key}]\n{text[:2500]}")

    system = (
        f"You are scripting a single-speaker ~{target_minutes}-minute audio walkthrough "
        "of an academic paper. The narrator is an experienced researcher giving a "
        "graduate-level seminar talk. The tone is precise, calm, and academically rigorous — "
        "closer to a methodical lecturer than a friendly explainer. No co-host, no rhetorical "
        "questions to a partner. The narrator is alone with the listener.\n\n"
        f"Output ONLY valid JSON: {{\"segments\": [{{\"segment\": \"...\", \"text\": \"...\"}}]}}.\n"
        f"Total spoken text: ~{target_words} words.\n"
        "Segment IDs: intro, section:summary, section:qa, section:notes, section:highlights, "
        "section:selection, section:assumptions, section:figures, section:cross, section:related, outro.\n"
        "Include only segments whose source data is present. intro ≤60 words; outro ≤50 words.\n"
        "No LaTeX. No markdown. Speak math out loud.\n"
        "Forbidden: Yeah, Right?, Basically, let's dive in, deep dive, wow, co-host phrasing.\n"
        "Use first-person singular or third-person on authors. Per-segment 40–220 words; split with :a/:b if longer."
    )

    user = (
        f"Paper: {paper.title}\nAuthors: {', '.join(paper.authors or [])}\n\n"
        f"Paper excerpt:\n{paper_text}\n\n"
        f"Section content:\n" + "\n\n".join(section_blocks)
    )

    meta = {"regenerations": 0, "words_total": 0, "model_tokens_in": 0, "model_tokens_out": 0}
    segments: list[dict] = []

    for attempt in range(2):
        raw = await provider.complete(system, user, max_tokens=4000, cache_user_prefix=user)
        parsed = _safe_parse_json(raw)
        segs = parsed.get("segments") if isinstance(parsed, dict) else []
        if not isinstance(segs, list):
            segs = []
        segments = [
            {"segment": s.get("segment", f"part:{i}"), "text": s.get("text", "")}
            for i, s in enumerate(segs)
            if isinstance(s, dict)
        ]
        ok, _ = validate_podcast_script(segments)
        if ok:
            break
        meta["regenerations"] += 1

    meta["words_total"] = sum(len(s.get("text", "").split()) for s in segments)
    return segments, meta


def _get_figure_prompt(paper_text: str, question: str) -> tuple[str, str]:
    """Return (system, user_text) for figure analysis."""
    paper_text = _sanitize_user_text(paper_text, max_chars=4000)
    question = _sanitize_user_text(question, max_chars=2000)
    context_block = paper_text[:4000]
    system = (
        "You are an expert science educator analyzing figures from academic papers. "
        "Provide clear, thorough, educational explanations. Use markdown formatting. "
        "Do NOT wrap output in JSON or code fences.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    if question.strip():
        user_text = f"""The user has a question about this figure from an academic paper.

User's question: {question}

Paper context (for reference):
{context_block}

Answer the question thoroughly, referencing specific elements of the figure. Use markdown formatting."""
    else:
        user_text = f"""Analyze this figure from an academic paper in detail.

Paper context (for reference):
{context_block}

Describe what the figure shows, what the axes/labels mean, the key takeaways, and how it relates to the paper. Use markdown formatting."""

    return system, user_text
