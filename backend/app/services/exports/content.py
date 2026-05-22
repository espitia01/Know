"""Shared helpers for analysis-pane export renderers."""

from __future__ import annotations

from typing import Any

from ..db import list_highlights
from ...models.schemas import ParsedPaper


SECTION_LABELS = {
    "prepare": "Prepare",
    "summary": "Summary",
    "assumptions": "Assumptions",
    "qa": "Q&A",
    "notes": "Notes",
    "highlights": "Highlights",
    "figures": "Figures",
    "selection": "Selection history",
    "cross": "Cross-paper Q&A",
    "related": "Related work",
}


def slugify_title(title: str, max_len: int = 60) -> str:
    import re

    slug = re.sub(r"[^\w\s-]", "", (title or "paper").lower())
    slug = re.sub(r"[\s_-]+", "-", slug).strip("-")
    return (slug or "paper")[:max_len]


def gather_export_context(
    paper: ParsedPaper,
    user_id: str,
    sections: list[str],
) -> dict[str, Any]:
    """Build a section-keyed content dict from cached analysis + tables."""
    cache = paper.cached_analysis or {}
    out: dict[str, Any] = {}

    if "prepare" in sections:
        out["prepare"] = cache.get("pre_reading") or cache.get("prepare")

    if "summary" in sections:
        out["summary"] = cache.get("summary")

    if "assumptions" in sections:
        out["assumptions"] = cache.get("assumptions")

    if "qa" in sections:
        out["qa"] = cache.get("qa_sessions") or []

    if "notes" in sections:
        out["notes"] = paper.notes or []

    if "highlights" in sections:
        out["highlights"] = list_highlights(user_id, paper.id)

    if "figures" in sections:
        out["figures"] = {
            "meta": paper.figures or [],
            "analyses": cache.get("figure_analyses") or [],
        }

    if "selection" in sections:
        out["selection"] = cache.get("selections") or []

    if "cross" in sections:
        out["cross"] = cache.get("cross_paper_qa") or []

    if "related" in sections:
        pr = cache.get("pre_reading") or {}
        out["related"] = {
            "prior_work": pr.get("prior_work") or pr.get("prior_work_topics") or [],
            "cited_by": cache.get("cited_by") or [],
        }

    return out


def section_has_content(key: str, data: Any) -> bool:
    if data is None:
        return False
    if isinstance(data, (list, dict, str)):
        return bool(data)
    return True
