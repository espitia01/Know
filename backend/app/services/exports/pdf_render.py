"""WeasyPrint PDF export renderer."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from ...models.schemas import ParsedPaper
from ..pdf_parser import get_figure_path
from .content import SECTION_LABELS, gather_export_context, slugify_title
from .markdown_html import markdown_to_html

_TEMPLATES = Path(__file__).resolve().parent / "templates"


def _jinja_env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(_TEMPLATES)),
        autoescape=select_autoescape(["html"]),
    )
    env.filters["markdown"] = markdown_to_html
    return env


def render_pdf(export_row: dict, paper: ParsedPaper, cache: dict) -> tuple[bytes, str, str]:
    """Return (pdf_bytes, content_type, filename)."""
    sections = export_row.get("sections") or []
    options = export_row.get("options") or {}
    paper_size = options.get("pdf", {}).get("paper_size", "Letter")
    include_figures = options.get("pdf", {}).get("include_figures", True)
    compact = options.get("pdf", {}).get("compact", False)

    content = gather_export_context(paper, export_row["user_id"], sections)

    # Attach local figure paths for WeasyPrint file:// URLs
    fig_block = content.get("figures") or {}
    metas = fig_block.get("meta") or paper.figures or []
    enriched = []
    for f in metas:
        fid = f.get("id") if isinstance(f, dict) else getattr(f, "id", None)
        entry = dict(f) if isinstance(f, dict) else f.model_dump()
        if fid and include_figures:
            p = get_figure_path(paper.id, fid)
            if p and p.exists():
                entry["local_path"] = str(p.resolve())
        enriched.append(entry)
    if "figures" in content:
        content["figures"]["meta"] = enriched

    env = _jinja_env()
    css_path = _TEMPLATES / "paper_export.css"
    css_text = css_path.read_text(encoding="utf-8")
    if paper_size == "A4":
        css_text = css_text.replace("--paper-size: Letter;", "--paper-size: A4;")

    template = env.get_template("paper_export.html.j2")
    html = template.render(
        paper=paper,
        sections=sections,
        section_labels=SECTION_LABELS,
        content=content,
        export_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        include_figures=include_figures,
        compact=compact,
    )

    from weasyprint import HTML, CSS

    pdf_bytes = HTML(string=html, base_url=str(_TEMPLATES)).write_pdf(
        stylesheets=[CSS(string=css_text)]
    )

    slug = slugify_title(paper.title)
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"Know-export-{slug}-{date}.pdf"
    return pdf_bytes, "application/pdf", filename
