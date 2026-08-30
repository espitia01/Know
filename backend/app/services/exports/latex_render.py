"""Compile analysis exports with LaTeX (article) and Beamer (slides)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from ...models.schemas import ParsedPaper
from .content import SECTION_LABELS, slugify_title
from .export_formatters import (
    assumptions_bullets,
    cross_qa_entries,
    notes_bullets,
    prepare_sections,
    qa_entries,
    related_bibliography,
    selection_entries,
    summary_sections,
)

_MATH_DISPLAY = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_MATH_INLINE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")
_LATEX_SPECIAL = str.maketrans({
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "&": r"\&",
    "%": r"\%",
    "#": r"\#",
    "_": r"\_",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
})


class LatexUnavailable(RuntimeError):
    """No TeX engine on PATH, or the compile failed."""


def _escape(text: str) -> str:
    return (text or "").translate(_LATEX_SPECIAL)


def _md_to_latex(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        raw = (
            value.get("markdown")
            or value.get("text")
            or value.get("explanation")
            or value.get("answer")
            or ""
        )
    else:
        raw = str(value)
    if not raw.strip():
        return ""

    holders: list[str] = []

    def _stash_display(m: re.Match) -> str:
        holders.append(f"\\[{m.group(1).strip()}\\]")
        return f"@@MATH{len(holders) - 1}@@"

    def _stash_inline(m: re.Match) -> str:
        holders.append(f"${m.group(1).strip()}$")
        return f"@@MATH{len(holders) - 1}@@"

    body = _MATH_DISPLAY.sub(_stash_display, raw)
    body = _MATH_INLINE.sub(_stash_inline, body)
    body = _escape(body)
    body = re.sub(r"^### (.+)$", r"\\subsubsection*{\1}", body, flags=re.M)
    body = re.sub(r"^## (.+)$", r"\\subsection*{\1}", body, flags=re.M)
    body = re.sub(r"^# (.+)$", r"\\section*{\1}", body, flags=re.M)
    body = re.sub(r"\*\*(.+?)\*\*", r"\\textbf{\1}", body)
    body = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"\\textit{\1}", body)
    lines = []
    in_list = False
    for line in body.splitlines():
        if re.match(r"^\s*[-*] ", line):
            if not in_list:
                lines.append("\\begin{itemize}")
                in_list = True
            lines.append("\\item " + re.sub(r"^\s*[-*] ", "", line))
        else:
            if in_list:
                lines.append("\\end{itemize}")
                in_list = False
            lines.append(line)
    if in_list:
        lines.append("\\end{itemize}")
    out = "\n".join(lines)
    for i, chunk in enumerate(holders):
        out = out.replace(f"@@MATH{i}@@", chunk)
    return out.strip()


def _preamble(kind: str, paper_size: str = "Letter") -> str:
    paper = "letterpaper" if paper_size != "A4" else "a4paper"
    packages = (
        "\\usepackage{amsmath,amssymb}\n"
        "\\usepackage{graphicx}\n"
        "\\usepackage{hyperref}\n"
        "\\usepackage{enumitem}\n"
        "\\usepackage[T1]{fontenc}\n"
        "\\usepackage{lmodern}\n"
    )
    if kind == "article":
        return (
            "\\documentclass[11pt]{article}\n"
            f"\\usepackage[{paper},margin=1in]{{geometry}}\n"
            + packages
        )
    return (
        "\\documentclass[aspectratio=169]{beamer}\n"
        "\\usetheme{default}\n"
        "\\setbeamertemplate{navigation symbols}{}\n"
        + packages
    )


def _title_block(paper: ParsedPaper) -> str:
    title = _escape(paper.title or "Untitled")
    authors = _escape(", ".join(paper.authors or []))
    date = datetime.now(timezone.utc).strftime("%B %d, %Y")
    return (
        f"\\title{{{title}}}\n"
        f"\\author{{{authors}}}\n"
        f"\\date{{Know analysis export \\textperiodcentered{{}} {date}}}\n"
    )


def _section_bodies(paper: ParsedPaper, cache: dict, sections: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for key in sections:
        label = SECTION_LABELS.get(key, key.title())
        chunks: list[str] = []
        if key == "summary":
            s = cache.get("summary") if isinstance(cache.get("summary"), dict) else {}
            fields = (
                ("Overview", s.get("overview")),
                ("Motivation", s.get("motivation")),
                ("Methodology", s.get("methodology")),
                ("Results", s.get("main_results")),
                ("Discussion", s.get("discussion")),
                ("Future work", s.get("future_work")),
            )
            for heading, val in fields:
                if val:
                    chunks.append(f"\\subsection*{{{_escape(heading)}}}")
                    chunks.append(_md_to_latex(val))
            contribs = [c for c in (s.get("key_contributions") or []) if c]
            if contribs:
                chunks.append("\\subsection*{Key contributions}")
                chunks.append("\\begin{itemize}")
                for c in contribs:
                    chunks.append(f"\\item {_md_to_latex(c)}")
                chunks.append("\\end{itemize}")
            if not chunks:
                for heading, paras in summary_sections(cache):
                    chunks.append(f"\\subsection*{{{_escape(heading)}}}")
                    for p in paras:
                        chunks.append(_md_to_latex(p))
        elif key == "prepare":
            for heading, paras in prepare_sections(cache):
                chunks.append(f"\\subsection*{{{_escape(heading)}}}")
                chunks.append("\\begin{itemize}")
                for p in paras:
                    chunks.append(f"\\item {_md_to_latex(p)}")
                chunks.append("\\end{itemize}")
        elif key == "assumptions":
            bullets = assumptions_bullets(cache)
            if bullets:
                chunks.append("\\begin{itemize}")
                for b in bullets:
                    chunks.append(f"\\item {_md_to_latex(b)}")
                chunks.append("\\end{itemize}")
        elif key == "qa":
            for q, a in qa_entries(cache):
                chunks.append(f"\\subsection*{{{_md_to_latex(q)}}}")
                chunks.append(_md_to_latex(a))
        elif key == "notes":
            bullets = notes_bullets(cache)
            if bullets:
                chunks.append("\\begin{itemize}")
                for b in bullets:
                    chunks.append(f"\\item {_md_to_latex(b)}")
                chunks.append("\\end{itemize}")
        elif key == "selection":
            for action, sel, body in selection_entries(cache):
                chunks.append(f"\\subsection*{{{_escape(action.title())}}}")
                if sel:
                    chunks.append(f"\\textit{{{_md_to_latex(sel)}}}\n")
                chunks.append(_md_to_latex(body))
        elif key == "cross":
            for q, a in cross_qa_entries(cache):
                chunks.append(f"\\subsection*{{{_md_to_latex(q)}}}")
                chunks.append(_md_to_latex(a))
        elif key == "related":
            for line in related_bibliography(cache):
                chunks.append(_md_to_latex(line) + "\n")
        elif key == "figures":
            fig = cache.get("figures") or {}
            analyses = fig.get("analyses") or []
            for item in analyses[:12]:
                if not isinstance(item, dict):
                    continue
                fid = _escape(str(item.get("figure_id") or "Figure"))
                chunks.append(f"\\subsection*{{{fid}}}")
                chunks.append(_md_to_latex(item.get("description") or item.get("answer") or ""))
        if not chunks:
            chunks.append("\\emph{No content generated for this section yet.}")
        out.append((label, "\n\n".join(c for c in chunks if c)))
    return out


def build_article_tex(
    paper: ParsedPaper,
    cache: dict,
    sections: list[str],
    *,
    paper_size: str = "Letter",
) -> str:
    parts = [
        _preamble("article", paper_size),
        _title_block(paper),
        "\\begin{document}\n\\maketitle\n\\tableofcontents\n",
    ]
    for label, body in _section_bodies(paper, cache, sections):
        parts.append(f"\\section{{{_escape(label)}}}\n{body}\n")
    parts.append("\\end{document}\n")
    return "\n".join(parts)


def build_beamer_tex(
    paper: ParsedPaper,
    cache: dict,
    sections: list[str],
) -> str:
    parts = [
        _preamble("beamer"),
        _title_block(paper),
        "\\begin{document}\n\\begin{frame}\\titlepage\\end{frame}\n",
    ]
    for label, body in _section_bodies(paper, cache, sections):
        parts.append(
            f"\\begin{{frame}}[allowframebreaks]{{{_escape(label)}}}\n{body}\n\\end{{frame}}\n"
        )
    parts.append("\\end{document}\n")
    return "\n".join(parts)


def _find_engine() -> tuple[str, list[str]] | None:
    tectonic = shutil.which("tectonic")
    if tectonic:
        return tectonic, ["--outfmt", "pdf"]
    pdflatex = shutil.which("pdflatex")
    if pdflatex:
        return pdflatex, ["-interaction=nonstopmode", "-halt-on-error"]
    return None


def compile_tex(source: str, *, jobname: str = "know-export") -> bytes:
    engine = _find_engine()
    if not engine:
        raise LatexUnavailable("No TeX engine (tectonic or pdflatex) on PATH")
    binary, extra = engine
    with tempfile.TemporaryDirectory(prefix="know-tex-") as tmp:
        tex_path = Path(tmp) / f"{jobname}.tex"
        tex_path.write_text(source, encoding="utf-8")
        cmd = [binary, *extra, str(tex_path)]
        env = os.environ.copy()
        env.setdefault("TEXMFVAR", tmp)
        try:
            subprocess.run(
                cmd,
                cwd=tmp,
                check=True,
                capture_output=True,
                timeout=90,
                env=env,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise LatexUnavailable(str(exc)) from exc
        pdf_path = Path(tmp) / f"{jobname}.pdf"
        if not pdf_path.exists():
            # pdflatex writes beside the .tex; tectonic may use the same.
            found = list(Path(tmp).glob("*.pdf"))
            if not found:
                raise LatexUnavailable("TeX compile produced no PDF")
            pdf_path = found[0]
        return pdf_path.read_bytes()


def _filename(paper: ParsedPaper, kind: str) -> str:
    slug = slugify_title(paper.title)
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    suffix = "slides" if kind == "beamer" else "export"
    return f"Know-{suffix}-{slug}-{date}.pdf"


def render_latex_pdf(export_row: dict, paper: ParsedPaper, cache: dict) -> tuple[bytes, str, str]:
    options = (export_row.get("options") or {}).get("pdf") or {}
    tex = build_article_tex(
        paper,
        cache,
        export_row.get("sections") or [],
        paper_size=options.get("paper_size", "Letter"),
    )
    pdf = compile_tex(tex, jobname="know-article")
    return pdf, "application/pdf", _filename(paper, "article")


def render_beamer_pdf(export_row: dict, paper: ParsedPaper, cache: dict) -> tuple[bytes, str, str]:
    tex = build_beamer_tex(paper, cache, export_row.get("sections") or [])
    pdf = compile_tex(tex, jobname="know-beamer")
    return pdf, "application/pdf", _filename(paper, "beamer")
