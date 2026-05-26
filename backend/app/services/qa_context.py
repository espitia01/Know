"""Supplement Q&A prompts with figure, table, and cached visual analysis context."""

from __future__ import annotations

import re
from typing import Iterable

from ..models.schemas import ParsedPaper

_TABLE_LABEL_RE = re.compile(
    r"(?:(?:Table|TABLE)\s+(?:S[\d.]+\s*)?[\dIVXLC]+(?:[.:]|(?=\s|$)))",
    re.I,
)
_PIPE_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
_PIPE_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}")
_FIGURE_LABEL_RE = re.compile(
    r"(?:(?:Figure|Fig\.|FIG\.)\s+(?:S[\d.]+\s*)?[\dIVXLC]+(?:[.:]|(?=\s|$)))",
    re.I,
)
_STOPWORDS = frozenset(
    {
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "must", "shall", "can", "need", "dare",
        "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
        "from", "up", "about", "into", "through", "during", "before", "after",
        "above", "below", "between", "under", "again", "further", "then",
        "once", "here", "there", "when", "where", "why", "how", "all", "each",
        "few", "more", "most", "other", "some", "such", "no", "nor", "not",
        "only", "own", "same", "so", "than", "too", "very", "just", "and",
        "but", "if", "or", "because", "as", "until", "while", "what", "which",
        "who", "whom", "this", "that", "these", "those", "am", "it", "its",
        "they", "them", "their", "we", "our", "you", "your", "he", "she", "his",
        "her", "paper", "show", "shows", "showed", "describe", "explain", "tell",
    }
)


def _query_terms(query: str) -> set[str]:
    terms: set[str] = set()
    for token in re.findall(r"[a-z0-9]+", (query or "").lower()):
        if len(token) >= 3 and token not in _STOPWORDS:
            terms.add(token)
    return terms


def _score_text(text: str, terms: set[str]) -> int:
    if not terms or not text:
        return 0
    hay = text.lower()
    return sum(1 for term in terms if term in hay)


def _extract_markdown_tables(markdown: str, *, max_chars: int) -> list[tuple[str, str]]:
    """Return (label, block) pairs for markdown tables and nearby captions."""
    text = (markdown or "").strip()
    if not text:
        return []

    lines = text.splitlines()
    blocks: list[tuple[str, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        cap_match = _TABLE_LABEL_RE.search(line)
        if cap_match:
            caption = line.strip()
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and _PIPE_TABLE_ROW_RE.match(lines[j]):
                table_lines = []
                k = j
                while k < len(lines) and _PIPE_TABLE_ROW_RE.match(lines[k]):
                    table_lines.append(lines[k])
                    k += 1
                block = caption + "\n" + "\n".join(table_lines)
                blocks.append((cap_match.group(0).strip(), block.strip()))
                i = k
                continue
            if len(caption) > 8:
                blocks.append((cap_match.group(0).strip(), caption))
            i += 1
            continue

        if _PIPE_TABLE_ROW_RE.match(line):
            table_lines = [line]
            i += 1
            if i < len(lines) and _PIPE_TABLE_SEP_RE.match(lines[i]):
                table_lines.append(lines[i])
                i += 1
            while i < len(lines) and _PIPE_TABLE_ROW_RE.match(lines[i]):
                table_lines.append(lines[i])
                i += 1
            block = "\n".join(table_lines).strip()
            label = "Table"
            if block:
                blocks.append((label, block))
            continue

        i += 1

    # De-dupe by block body while preserving order.
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    total = 0
    for label, block in blocks:
        key = block[:120]
        if key in seen:
            continue
        seen.add(key)
        if total + len(block) > max_chars:
            remaining = max_chars - total
            if remaining <= 120:
                break
            block = block[:remaining]
        out.append((label, block))
        total += len(block) + 2
    return out


def _figure_catalog_lines(paper: ParsedPaper) -> list[str]:
    lines: list[str] = []
    for fig in paper.figures or []:
        caption = (fig.caption or "").strip()
        page = (fig.page or 0) + 1
        label = _FIGURE_LABEL_RE.search(caption)
        name = label.group(0).strip() if label else fig.id
        if caption:
            lines.append(f"- {name} (page {page}): {caption}")
        else:
            lines.append(f"- {fig.id} (page {page})")
    for img in paper.ocr_images or []:
        caption = (img.caption or "").strip()
        if not caption:
            continue
        label = _FIGURE_LABEL_RE.search(caption)
        name = label.group(0).strip() if label else img.id
        lines.append(f"- {name} (page {(img.page or 0) + 1}, OCR): {caption}")
    return lines


def _cached_visual_lines(paper: ParsedPaper) -> list[str]:
    cache = paper.cached_analysis or {}
    lines: list[str] = []

    for key in ("summary_deep", "summary", "summary_lite"):
        block = cache.get(key)
        if not isinstance(block, dict):
            continue
        for item in block.get("key_figures_and_tables") or []:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or "").strip()
            desc = str(item.get("description") or "").strip()
            if item_id and desc:
                lines.append(f"- {item_id} (summary): {desc}")

    for analysis in cache.get("figure_analyses") or []:
        if not isinstance(analysis, dict):
            continue
        fig_id = str(analysis.get("figure_id") or "").strip()
        question = str(analysis.get("question") or "").strip()
        description = str(analysis.get("description") or "").strip()
        answer = str(analysis.get("answer") or "").strip()
        takeaway = str(analysis.get("takeaway") or "").strip()
        relation = str(analysis.get("relation_to_paper") or "").strip()
        observations = analysis.get("key_observations") or []
        header = fig_id or "Figure"
        parts = [p for p in (description, answer, takeaway, relation) if p]
        if isinstance(observations, list):
            obs = [str(o).strip() for o in observations if str(o).strip()]
            if obs:
                parts.append("Observations: " + "; ".join(obs[:4]))
        if question:
            parts.insert(0, f"Q: {question}")
        if parts:
            lines.append(f"- {header} (prior analysis): " + " ".join(parts)[:900])

    return lines


def _rank_lines(lines: Iterable[str], terms: set[str]) -> list[str]:
    scored = sorted(
        ((line, _score_text(line, terms)) for line in lines if line.strip()),
        key=lambda pair: pair[1],
        reverse=True,
    )
    return [line for line, score in scored if score > 0] + [
        line for line, score in scored if score == 0
    ]


def build_qa_visual_context(
    paper: ParsedPaper,
    query: str,
    *,
    max_chars: int = 2500,
) -> str:
    """Build a compact figures/tables supplement for batch Q&A."""
    if max_chars <= 0:
        return ""

    terms = _query_terms(query)
    sections: list[str] = []

    catalog = _figure_catalog_lines(paper)
    if catalog:
        ranked = _rank_lines(catalog, terms)
        sections.append("### Figure catalog\n" + "\n".join(ranked[:12]))

    cached = _cached_visual_lines(paper)
    if cached:
        ranked = _rank_lines(cached, terms)
        sections.append("### Cached figure/table analysis\n" + "\n".join(ranked[:8]))

    markdown = (paper.markdown or "").strip() or (paper.raw_text or "")
    tables = _extract_markdown_tables(markdown, max_chars=max(800, max_chars // 2))
    if tables:
        ranked_tables = sorted(
            tables,
            key=lambda pair: _score_text(pair[1], terms),
            reverse=True,
        )
        table_lines = [f"#### {label}\n{block}" for label, block in ranked_tables[:6]]
        sections.append("### Tables from manuscript\n" + "\n\n".join(table_lines))

    if not sections:
        return ""

    body = "\n\n".join(sections).strip()
    if len(body) <= max_chars:
        return body
    return body[: max_chars - 1].rstrip() + "…"
