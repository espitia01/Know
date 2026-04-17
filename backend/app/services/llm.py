"""LLM service abstraction with Anthropic and local model providers."""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod

import httpx

from ..config import settings

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
HAIKU_MODEL = "claude-haiku-4-5"
SONNET_MODEL = "claude-sonnet-4-6"


class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, system: str, user: str, max_tokens: int = 4096) -> str: ...


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = SONNET_MODEL):
        self.api_key = api_key
        self.model = model
        self.client = httpx.AsyncClient(timeout=300.0)

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


class LocalModelProvider(LLMProvider):
    """OpenAI-compatible provider for local models (Ollama, LM Studio, etc.)."""

    def __init__(self, base_url: str, model_name: str):
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.client = httpx.AsyncClient(timeout=120.0)

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


def get_provider() -> LLMProvider:
    """Get the user-configured LLM provider (Sonnet for analysis tasks)."""
    if settings.active_provider == "local" and settings.local_model_url:
        return LocalModelProvider(settings.local_model_url, settings.local_model_name)
    if settings.anthropic_api_key:
        return AnthropicProvider(settings.anthropic_api_key, model=SONNET_MODEL)
    raise ValueError(
        "No LLM provider configured. Set KNOW_ANTHROPIC_API_KEY or configure a local model."
    )


def get_haiku_provider() -> AnthropicProvider:
    """Get a Haiku provider for fast formatting tasks. Always uses Anthropic API."""
    if not settings.anthropic_api_key:
        raise ValueError("Anthropic API key required for paper formatting.")
    return AnthropicProvider(settings.anthropic_api_key, model=HAIKU_MODEL)


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
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Attempt repair: close unclosed strings and braces
        repaired = cleaned
        if repaired.count('"') % 2 == 1:
            repaired += '"'
        open_braces = repaired.count("{") - repaired.count("}")
        open_brackets = repaired.count("[") - repaired.count("]")
        repaired += "]" * max(0, open_brackets)
        repaired += "}" * max(0, open_braces)
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            return {}


# ---------------------------------------------------------------------------
# Haiku formatting (runs during upload)
# ---------------------------------------------------------------------------

async def format_paper_with_haiku(raw_text: str) -> dict:
    """Send raw PDF text to Haiku, get back clean markdown + metadata.

    Returns dict with keys: title, authors, abstract, content_markdown
    """
    provider = get_haiku_provider()

    system = """You are an expert academic typesetter. Convert raw PDF-extracted text into clean, readable markdown.

Rules:
- Start with a YAML-style metadata block fenced by --- lines containing:
  title, authors, affiliations, and abstract
- CRITICAL for authors: Write each author with their affiliation superscript numbers, e.g.: "John Smith1, Jane Doe1,2, Bob Lee3"
- CRITICAL for affiliations: Number each affiliation, e.g.: "1 Department of Physics, MIT; 2 Department of Chemistry, Stanford; 3 Harvard University"
- The mapping between authors and affiliations MUST be preserved from the original paper
- The affiliations line MUST include the full institution names and departments as they appear in the paper
- Then output the full paper body as clean markdown
- Fix broken sentences and words split across lines/columns
- Use ## for section headings, ### for subsections
- Preserve ALL mathematical content using LaTeX: inline math with $...$ and display math with $$...$$
- Reconstruct garbled equations from the PDF extraction into proper LaTeX
- Remove page headers/footers, page numbers, journal boilerplate, "Downloaded from..." lines
- Remove figure placeholder labels like "Figure fig_p0_0"
- Place "## References" as the LAST section, format as a numbered markdown list (1. Author, Title...)
- CRITICAL: include ALL references from the paper, do NOT stop early or truncate
- Do NOT summarize or shorten -- keep ALL content from the paper
- Output ONLY the metadata block + markdown, no other commentary"""

    user = f"""Convert this raw PDF extraction into clean markdown with a metadata header:

{raw_text[:60000]}"""

    result = await provider.complete(system, user, max_tokens=32000)
    return _parse_haiku_output(result)


def _parse_haiku_output(text: str) -> dict:
    """Parse the metadata block + markdown body from Haiku's response."""
    title = ""
    authors: list[str] = []
    affiliations: list[str] = []
    abstract = ""
    body = text

    if text.strip().startswith("---"):
        parts = text.strip().split("---", 2)
        if len(parts) >= 3:
            meta_block = parts[1]
            body = parts[2].strip()

            for line in meta_block.strip().splitlines():
                line = line.strip()
                if line.lower().startswith("title:"):
                    title = line.split(":", 1)[1].strip().strip('"').strip("'")
                elif line.lower().startswith("authors:"):
                    raw_authors = line.split(":", 1)[1].strip().strip('"').strip("'")
                    authors = [a.strip().strip('"').strip("'") for a in raw_authors.split(",") if a.strip()]
                elif line.lower().startswith("affiliations:"):
                    raw_aff = line.split(":", 1)[1].strip().strip('"').strip("'")
                    affiliations = [a.strip() for a in raw_aff.split(";") if a.strip()]
                elif line.lower().startswith("abstract:"):
                    abstract = line.split(":", 1)[1].strip().strip('"').strip("'")

    if not title:
        for line in body.splitlines():
            stripped = line.strip()
            if stripped.startswith("# ") and not stripped.startswith("## "):
                title = stripped[2:].strip()
                break

    if not abstract:
        abstract_match = re.search(
            r"(?:^|\n)#+\s*Abstract\s*\n+([\s\S]*?)(?=\n##|\Z)",
            body, re.IGNORECASE
        )
        if abstract_match:
            abstract = abstract_match.group(1).strip()[:2000]

    references: list[dict] = []
    content_body = body

    refs_match = re.search(
        r"\n##\s*References(?:\s+and\s+Notes)?\s*\n",
        body, re.IGNORECASE
    )
    if refs_match:
        refs_text = body[refs_match.end():]
        content_body = body[: refs_match.start()].rstrip()
        for m in re.finditer(r"(\d+)\.\s+(.+?)(?=\n\d+\.\s|\Z)", refs_text, re.DOTALL):
            ref_num = m.group(1)
            ref_text = m.group(2).strip().replace("\n", " ")
            references.append({"id": ref_num, "text": ref_text})

    return {
        "title": title,
        "authors": authors,
        "affiliations": affiliations,
        "abstract": abstract,
        "content_markdown": content_body,
        "references": references,
    }


# ---------------------------------------------------------------------------
# Analysis functions (use Sonnet or user-configured provider)
# ---------------------------------------------------------------------------

async def analyze_paper(paper_text: str) -> dict:
    """Run pre-reading analysis on paper content."""
    provider = get_provider()

    system = """You are an expert science educator. Analyze the given academic paper and extract structured information to help a student prepare before reading. Return ONLY valid JSON with no other text."""

    user = f"""Analyze this paper and return a JSON object with these fields:

1. "definitions": array of {{"term": "...", "definition": "...", "source": "..."}} - key technical terms and their definitions. Use LaTeX notation for math (e.g., $E = mc^2$).
2. "research_questions": array of {{"question": "...", "context": "..."}} - the main questions this paper tries to answer
3. "prior_work": array of {{"title": "...", "relevance": "...", "ref_id": "..."}} - important prior work this paper builds on
4. "concepts": array of {{"name": "...", "description": "...", "importance": "..."}} - key scientific/physics concepts the reader should understand. Use LaTeX for math.

Paper content:
{paper_text[:15000]}"""

    raw = await provider.complete(system, user, max_tokens=8192)
    return _safe_parse_json(raw)


async def explain_term(paper_text: str, term: str, context: str) -> dict:
    """Explain a term in the context of the paper."""
    provider = get_provider()

    system = """You are an expert science educator. Explain technical terms clearly and accurately. Return ONLY valid JSON."""

    user = f"""Given this paper context, explain the term "{term}".

Additional context from the user: {context}

First check if the term is defined in the paper. Then provide a clear explanation.
Use LaTeX notation for any math (e.g., $\\nabla \\cdot E = \\rho / \\epsilon_0$).

Return JSON: {{"term": "...", "explanation": "...", "source": "name of source if from another paper", "in_paper": true/false}}

Paper excerpt:
{paper_text[:10000]}"""

    raw = await provider.complete(system, user)
    return _safe_parse_json(raw)


async def find_skipped_steps(paper_text: str, section: str) -> dict:
    """Identify and fill in skipped derivation steps."""
    provider = get_provider()

    system = """You are an expert physicist and mathematics educator. When given a derivation from a paper, identify any steps that were skipped and provide the intermediate steps. Return ONLY valid JSON."""

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

    raw = await provider.complete(system, user)
    return _safe_parse_json(raw)


async def extract_assumptions(paper_text: str) -> dict:
    """Extract explicit and implicit assumptions."""
    provider = get_provider()

    system = """You are an expert science educator. Identify all assumptions in the paper, both those explicitly stated and those implied. Return ONLY valid JSON."""

    user = f"""Analyze this paper and extract all assumptions, both explicit (clearly stated) and implicit (unstated but necessary for the conclusions to hold).

Paper content:
{paper_text[:12000]}

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

    raw = await provider.complete(system, user)
    return _safe_parse_json(raw)


async def generate_derivation_exercise(paper_text: str, section: str) -> dict:
    """Generate an interactive derivation exercise with fill-in-the-blank steps."""
    provider = get_provider()

    system = """You are an expert physics/mathematics educator creating interactive derivation exercises. Your exercises must be detailed, pedagogical, and genuinely useful for a student trying to learn the material. Return ONLY valid JSON."""

    user = f"""Create a thorough step-by-step derivation exercise based on the section titled "{section}" from this paper.

CRITICAL INSTRUCTIONS:
- Find the key derivation or mathematical argument in this section
- Break it into 6-12 ATOMIC steps where each step involves exactly one algebraic manipulation, substitution, or logical move
- Each step MUST have:
  * "prompt": A clear instruction telling the student what to do (e.g., "Substitute the expression for X into equation Y", "Take the derivative of both sides with respect to t", "Apply the chain rule to expand the left side")
  * "answer": The resulting mathematical expression after performing the step (use LaTeX like $...$)
  * "explanation": WHY this step works and what principle it uses (2-3 sentences)
  * "hint": A gentle nudge without giving away the answer
- The prompts must be specific enough that a student knows exactly what operation to perform
- Start from a clearly stated starting equation/expression
- End at the final result from the paper

Full paper context:
{paper_text[:12000]}

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
}}

Make sure every step is concrete and actionable. Do NOT use vague prompts like "simplify" or "continue". Be specific: "Factor out $k_B T$ from the numerator", "Apply integration by parts with $u = x$ and $dv = e^{{-x}} dx$", etc."""

    raw = await provider.complete(system, user, max_tokens=8192)
    return _safe_parse_json(raw)


async def answer_questions(paper_text: str, questions: list[str]) -> list[dict]:
    """Answer a batch of questions about the paper."""
    provider = get_provider()

    system = """You are an expert science educator. Answer questions about the paper thoroughly but accessibly. Use LaTeX for math expressions. Return ONLY valid JSON."""

    q_list = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))

    user = f"""Answer these questions about the paper. For each, provide a clear, educational answer using the paper content.

Questions:
{q_list}

Paper content:
{paper_text[:12000]}

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
