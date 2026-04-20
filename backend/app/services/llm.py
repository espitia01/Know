"""LLM service abstraction with Anthropic and local model providers."""

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

from ..config import settings

logger = logging.getLogger(__name__)
_warned_missing_key = False

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
HAIKU_MODEL = "claude-haiku-4-5"
SONNET_MODEL = "claude-sonnet-4-6"
OPUS_MODEL = "claude-opus-4"

MAX_IMAGE_DIMENSION = 1024

LATEX_FORMAT_INSTRUCTIONS = """LATEX FORMATTING RULES (STRICT — follow exactly):
- Use $...$ for inline math (variables, single symbols, short expressions)
- Use $$...$$ for display math (any equation with \\frac, \\sum, \\int, \\prod, \\lim, matrices, multi-line expressions, or anything longer than a few tokens)
- Put each display equation on its own line with a blank line before and after the $$...$$ block
- NEVER use \\( \\) or \\[ \\] delimiters — always $ or $$
- NEVER output Unicode math characters (e.g. σ, μ, ∑, ∫, ², ₙ, subscripts, superscripts, fractions as separate characters). ALWAYS write them in LaTeX: \\sigma, \\mu, \\sum, \\int, x^2, x_n, \\frac{a}{b}
- NEVER mix bare/raw symbols and LaTeX in the same expression. If an equation has ANY math, wrap the ENTIRE equation in $...$ or $$...$$
- For matrices use \\begin{pmatrix}...\\end{pmatrix} (or bmatrix/vmatrix) inside $$...$$
- For multi-character function names use \\operatorname{name} or \\text{name}
- Use \\cdot for multiplication, \\left( \\right) for auto-sized parens around large expressions
- Do not break a single equation into multiple $...$ fragments — keep it as one continuous math expression"""



def _ssl_context():
    """Build an SSL context, preferring certifi, falling back to system certs."""
    try:
        return ssl.create_default_context(cafile=certifi.where())
    except ssl.SSLError:
        return ssl.create_default_context()


class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, system: str, user: str, max_tokens: int = 4096) -> str: ...


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

    async def complete(self, system: str, user: str, max_tokens: int = 4096) -> str:
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
                "messages": [{"role": "user", "content": user}],
            },
        )
        response.raise_for_status()
        data = response.json()
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
            response.raise_for_status()
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
                                    "data": image_b64,
                                },
                            },
                            {"type": "text", "text": text},
                        ],
                    }
                ],
            },
        )
        response.raise_for_status()
        data = response.json()
        return data["content"][0]["text"]

    async def stream_complete_with_image(
        self, system: str, text: str, image_b64: str, media_type: str = "image/png", max_tokens: int = 4096
    ) -> AsyncIterator[str]:
        """Stream a vision response token-by-token."""
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
                                    "data": image_b64,
                                },
                            },
                            {"type": "text", "text": text},
                        ],
                    }
                ],
            },
        ) as response:
            response.raise_for_status()
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


class LocalModelProvider(LLMProvider):
    """OpenAI-compatible provider for local models (Ollama, LM Studio, etc.)."""

    _ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}

    def __init__(self, base_url: str, model_name: str):
        from urllib.parse import urlparse
        parsed = urlparse(base_url)
        if parsed.hostname not in self._ALLOWED_HOSTS:
            raise ValueError(f"LocalModelProvider only allows local hosts, got: {parsed.hostname}")
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.client = _get_shared_client()

    async def complete(self, system: str, user: str, max_tokens: int = 4096) -> str:
        response = await self.client.post(
            f"{self.base_url}/chat/completions",
            json={
                "model": self.model_name,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.3,
            },
        )
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]


def get_provider(user_id: str | None = None) -> LLMProvider:
    """Get the LLM provider for heavy analysis tasks, enforcing tier model limits."""
    if not settings.anthropic_api_key:
        global _warned_missing_key
        if not _warned_missing_key:
            logger.critical(
                "KNOW_ANTHROPIC_API_KEY is not set — all LLM-backed endpoints "
                "will return 503 until it is configured."
            )
            _warned_missing_key = True
        raise ValueError("No API key configured. Set KNOW_ANTHROPIC_API_KEY.")
    model = settings.analysis_model
    if user_id:
        from ..api.settings import _get_user_model_prefs
        model, _ = _get_user_model_prefs(user_id)
        from ..gating import enforce_model
        model = enforce_model(user_id, model)
    return AnthropicProvider(settings.anthropic_api_key, model=model)


def get_fast_provider(user_id: str | None = None) -> LLMProvider:
    """Get a faster LLM provider for interactive tasks, enforcing tier model limits."""
    if not settings.anthropic_api_key:
        global _warned_missing_key
        if not _warned_missing_key:
            logger.critical(
                "KNOW_ANTHROPIC_API_KEY is not set — all LLM-backed endpoints "
                "will return 503 until it is configured."
            )
            _warned_missing_key = True
        raise ValueError("No API key configured. Set KNOW_ANTHROPIC_API_KEY.")
    model = settings.fast_model
    if user_id:
        from ..api.settings import _get_user_model_prefs
        _, model = _get_user_model_prefs(user_id)
        from ..gating import enforce_model
        model = enforce_model(user_id, model)
    return AnthropicProvider(settings.anthropic_api_key, model=model)


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


def _normalize_latex_delimiters(obj):
    """Convert \\( \\) to $ and \\[ \\] to $$ in all string values for remark-math compatibility."""
    if isinstance(obj, str):
        s = obj
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
# Selection-based analysis (triggered by highlighting text in the PDF)
# ---------------------------------------------------------------------------

async def analyze_selection(paper_text: str, selected_text: str, action: str, user_id: str | None = None) -> dict:
    """Analyze a user-highlighted selection from the PDF using the fast provider."""
    provider = get_fast_provider(user_id)
    selected_text = _sanitize_user_text(selected_text)
    paper_text = _sanitize_user_text(paper_text, max_chars=6000)

    action_prompts = {
        "explain": f"""Explain the following passage from an academic paper clearly and thoroughly.
Break down every piece of jargon, clarify the logic step by step, and provide broader context
including implications, connections to other concepts, and why this matters.
Use LaTeX for math ($...$).

Selected text:
\"\"\"{selected_text}\"\"\"

Full paper context:
{paper_text[:6000]}

Return JSON:
{{"explanation": "thorough, clear explanation that covers jargon, logic, context, implications, and connections. Use LaTeX math where relevant."}}""",

        "assumptions": f"""Identify the explicit and implicit assumptions underlying this passage.
For each assumption, explain why it matters and what would change if it didn't hold.

Selected text:
\"\"\"{selected_text}\"\"\"

Full paper context:
{paper_text[:6000]}

Return JSON:
{{"assumptions": [{{"statement": "...", "type": "explicit|implicit", "significance": "..."}}]}}""",

        "derive": f"""The user wants to understand the derivation in this passage step-by-step.
Break it down into atomic steps, filling in any gaps. Each step should have a clear prompt,
the resulting expression (LaTeX), and an explanation.

Selected text:
\"\"\"{selected_text}\"\"\"

Full paper context:
{paper_text[:6000]}

Return JSON:
{{
  "title": "Derivation of [specific result]",
  "starting_point": "initial expression (LaTeX)",
  "final_result": "target expression (LaTeX)",
  "steps": [
    {{
      "step_number": 1,
      "prompt": "what to do in this step",
      "answer": "resulting expression (LaTeX)",
      "explanation": "why this works",
      "hint": "a helpful nudge"
    }}
  ]
}}""",

        "question": f"""Answer the following question about the paper, using the selected passage as focus.
Be thorough, educational, and use LaTeX for math.

Selected text / question context:
\"\"\"{selected_text}\"\"\"

Full paper context:
{paper_text[:6000]}

Return JSON:
{{"answer": "thorough educational answer with LaTeX math where relevant"}}""",
    }

    prompt = action_prompts.get(action, action_prompts["explain"])
    system = (
        "You are an expert science educator. Analyze academic paper content to help students learn. "
        "Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )
    raw = await provider.complete(system, prompt, max_tokens=8192)
    result = _safe_parse_json(raw)
    result["action"] = action
    result["selected_text"] = selected_text
    return result


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
        "or missing entirely. Use the paper context to infer the correct equations and symbols. "
        "Always reproduce equations correctly in LaTeX even if the selected text is mangled."
    )

    prompts = {
        "explain": f"""Explain the following passage from an academic paper clearly and thoroughly.
Break down every piece of jargon, clarify the logic step by step, and provide broader context
including implications, connections to other concepts, and why this matters.
Use LaTeX for math ($...$). Use markdown formatting.
Note: The selected text is extracted from a PDF text layer and mathematical symbols may be garbled or missing. Interpret them using context.

Selected text:
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}""",

        "assumptions": f"""Identify the explicit and implicit assumptions underlying this passage.
For each assumption, explain why it matters and what would change if it didn't hold.
Use markdown formatting with bullet points.
Note: Mathematical symbols in the selection may be garbled from PDF extraction. Interpret using context.

Selected text:
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}""",

        "derive": f"""Break down the derivation in this passage step-by-step.
Fill in any gaps with atomic steps. For each step provide the expression (LaTeX) and explanation.
Use markdown formatting with numbered steps.
Note: Mathematical symbols in the selection may be garbled from PDF extraction. Reconstruct the correct equations using paper context.

Selected text:
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}""",

        "question": f"""Answer the following question about the paper, using the selected passage as focus.
Be thorough, educational, and use LaTeX for math. Use markdown formatting.
Note: If the selection contains garbled math from PDF extraction, interpret it using paper context.

Selected text / question:
\"\"\"{selected_text}\"\"\"

Paper context:
{paper_text[:6000]}""",
    }

    return system, prompts.get(action, prompts["explain"])


# ---------------------------------------------------------------------------
# Analysis functions (use Sonnet or user-configured provider)
# ---------------------------------------------------------------------------

async def analyze_paper(paper_text: str, user_id: str | None = None) -> dict:
    """Run pre-reading analysis on paper content."""
    provider = get_provider(user_id)
    paper_text = _sanitize_user_text(paper_text, max_chars=15000)

    system = (
        "You are an expert science educator. Analyze the given academic paper and extract structured information "
        "to help a student prepare before reading. Return ONLY valid JSON with no other text.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    user = f"""Analyze this paper and return a JSON object with these fields:

1. "definitions": array of {{"term": "...", "definition": "...", "source": "..."}} - key technical terms and their definitions. Use LaTeX notation for math (e.g., $E = mc^2$).
2. "research_questions": array of {{"question": "...", "context": "..."}} - the main questions this paper tries to answer
3. "prior_work": array of {{"title": "...", "relevance": "...", "ref_id": "..."}} - important prior work this paper builds on
4. "concepts": array of {{"name": "...", "description": "...", "importance": "..."}} - key scientific/physics concepts the reader should understand. Use LaTeX for math.

Paper content:
{paper_text[:15000]}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    return _safe_parse_json(raw)


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

    raw = await provider.complete(system, user, max_tokens=4096)
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

    raw = await provider.complete(system, user, max_tokens=4096)
    return _safe_parse_json(raw)


async def extract_assumptions(paper_text: str, user_id: str | None = None) -> dict:
    """Extract explicit and implicit assumptions."""
    provider = get_provider(user_id)
    paper_text = _sanitize_user_text(paper_text, max_chars=6000)

    system = (
        "You are an expert science educator. Identify all assumptions in the paper, both those explicitly "
        "stated and those implied. Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    user = f"""Analyze this paper and extract all assumptions, both explicit (clearly stated) and implicit (unstated but necessary for the conclusions to hold).

Paper content:
{paper_text[:6000]}

Return JSON:
{{
  "assumptions": [
    {{
      "statement": "the assumption",
      "type": "explicit" or "implicit",
      "section": "which section this relates to"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=4096)
    return _safe_parse_json(raw)


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


async def answer_questions(paper_text: str, questions: list[str], user_id: str | None = None) -> list[dict]:
    """Answer a batch of questions about the paper."""
    provider = get_provider(user_id)
    paper_text = _sanitize_user_text(paper_text, max_chars=6000)
    questions = [_sanitize_user_text(q, max_chars=2000) for q in questions]

    system = (
        "You are an expert science educator. Answer questions about the paper thoroughly but accessibly. "
        "Return ONLY valid JSON.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    q_list = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))

    user = f"""Answer these questions about the paper. For each, provide a clear, educational answer using the paper content.

Questions:
{q_list}

Paper content:
{paper_text[:6000]}

Return JSON:
{{
  "items": [
    {{
      "question": "the original question",
      "answer": "thorough answer using LaTeX for math (e.g., $E = mc^2$)"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    return _safe_parse_json(raw)


MULTI_QA_TOTAL_CHAR_BUDGET = 30_000


async def answer_questions_multi(paper_texts: list[tuple[str, str]], questions: list[str], user_id: str | None = None) -> list[dict]:
    """Answer questions using context from multiple papers.
    paper_texts: list of (title, raw_text) tuples.

    The total context is capped at ``MULTI_QA_TOTAL_CHAR_BUDGET`` so a
    workspace with many large papers can't produce a multi-megabyte prompt
    (and the corresponding Anthropic bill). Each paper gets an equal share
    of the budget, with at least 2k chars each and a floor of 1 paper.
    """
    provider = get_provider(user_id)
    questions = [_sanitize_user_text(q, max_chars=2000) for q in questions]

    system = (
        "You are an expert science educator. You have access to multiple papers in a reading session. "
        "Answer questions by synthesizing information across all provided papers. "
        "Reference specific papers by title when citing information. Return ONLY valid JSON.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )

    q_list = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))

    papers_context = ""
    n_papers = max(1, len(paper_texts))
    chars_per_paper = max(2000, MULTI_QA_TOTAL_CHAR_BUDGET // n_papers)
    for i, (title, text) in enumerate(paper_texts):
        safe_title = _sanitize_user_text(title or "", max_chars=200)
        safe_text = _sanitize_user_text(text or "", max_chars=chars_per_paper)
        papers_context += f"\n--- Paper {i+1}: {safe_title} ---\n{safe_text}\n"

    user = f"""Answer these questions using all the papers in the session. Synthesize across papers where relevant.

Questions:
{q_list}

{papers_context}

Return JSON:
{{
  "items": [
    {{
      "question": "the original question",
      "answer": "thorough answer synthesizing across papers, referencing paper titles when citing specific information"
    }}
  ]
}}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    return _safe_parse_json(raw)


async def summarize_paper(paper_text: str, model_override: str | None = None, user_id: str | None = None) -> dict:
    """Generate an extremely detailed, structured summary of the paper."""
    if model_override:
        if user_id:
            from ..gating import enforce_model
            model_override = enforce_model(user_id, model_override)
        provider = AnthropicProvider(settings.anthropic_api_key, model=model_override)
    else:
        provider = get_provider(user_id)

    paper_text = _sanitize_user_text(paper_text, max_chars=12000)

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
{paper_text[:12000]}

Return JSON with all the above fields."""

    raw = await provider.complete(system, user, max_tokens=6000)
    return _safe_parse_json(raw)


def _resize_image_b64(image_b64: str, max_dim: int = MAX_IMAGE_DIMENSION) -> str:
    """Downscale a base64 PNG if either dimension exceeds max_dim. Uses PyMuPDF."""
    import base64
    import fitz

    try:
        raw = base64.b64decode(image_b64)
        pix = fitz.Pixmap(raw)
        w, h = pix.width, pix.height
        if w <= max_dim and h <= max_dim:
            return image_b64

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
        return image_b64


async def analyze_figure(paper_text: str, image_b64: str, question: str = "", user_id: str | None = None) -> dict:
    """Analyze a figure from the paper using Claude's vision capability."""
    provider = get_fast_provider(user_id)
    if not isinstance(provider, AnthropicProvider):
        raise ValueError("Figure analysis requires an Anthropic provider with vision support.")

    image_b64 = _resize_image_b64(image_b64)
    paper_text = _sanitize_user_text(paper_text, max_chars=4000)
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
{paper_text[:4000]}

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
{paper_text[:4000]}

Describe what the figure shows, what the axes/labels mean, and how it relates to the paper.

Return JSON:
{{
  "description": "detailed description of what the figure shows",
  "key_observations": ["observation 1", "observation 2"],
  "methodology_shown": "what method this figure illustrates (if applicable)",
  "relation_to_paper": "how this figure supports the paper's arguments",
  "takeaway": "the main conclusion from this figure"
}}"""

    raw = await provider.complete_with_image(system, user_text, image_b64, max_tokens=2048)
    return _safe_parse_json(raw)


def _get_figure_prompt(paper_text: str, question: str) -> tuple[str, str]:
    """Return (system, user_text) for figure analysis."""
    paper_text = _sanitize_user_text(paper_text, max_chars=4000)
    question = _sanitize_user_text(question, max_chars=2000)
    system = (
        "You are an expert science educator analyzing figures from academic papers. "
        "Provide clear, thorough, educational explanations. Use markdown formatting. "
        "Do NOT wrap output in JSON or code fences.\n\n" + LATEX_FORMAT_INSTRUCTIONS
    )

    if question.strip():
        user_text = f"""The user has a question about this figure from an academic paper.

User's question: {question}

Paper context (for reference):
{paper_text[:4000]}

Answer the question thoroughly, referencing specific elements of the figure. Use markdown formatting."""
    else:
        user_text = f"""Analyze this figure from an academic paper in detail.

Paper context (for reference):
{paper_text[:4000]}

Describe what the figure shows, what the axes/labels mean, the key takeaways, and how it relates to the paper. Use markdown formatting."""

    return system, user_text
