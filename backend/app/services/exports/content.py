"""Shared helpers for analysis-pane export renderers."""

from __future__ import annotations

from typing import Any

from ...models.schemas import ParsedPaper


SECTION_LABELS = {
    "prepare": "Prepare",
    "summary": "Summary",
    "assumptions": "Assumptions",
    "qa": "Q&A",
    "notes": "Notes",
    "figures": "Figures",
    "selection": "Selection history",
    "cross": "Cross-paper Q&A",
    "related": "References",
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
        out["summary"] = (
            cache.get("summary")
            or cache.get("summary_deep")
            or cache.get("summary_lite")
        )

    if "assumptions" in sections:
        out["assumptions"] = cache.get("assumptions")

    if "qa" in sections:
        out["qa"] = cache.get("qa_sessions") or []

    if "notes" in sections:
        out["notes"] = paper.notes or []

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
        cited = cache.get("cited_by")
        cited_items = cited.get("items") if isinstance(cited, dict) else cited
        out["related"] = {
            "prior_work": pr.get("prior_work") or [],
            "prior_work_topics": pr.get("prior_work_topics") or [],
            "cited_by": cited_items or [],
        }

    return out


def section_has_content(key: str, data: Any) -> bool:
    if data is None:
        return False
    if isinstance(data, (list, dict, str)):
        return bool(data)
    return True
