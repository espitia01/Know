"""python-pptx PowerPoint export renderer."""

from __future__ import annotations

import io
import re
from datetime import datetime, timezone

from pptx import Presentation
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

from ...models.schemas import ParsedPaper
from ..pdf_parser import get_figure_path
from .content import SECTION_LABELS, gather_export_context, slugify_title
from .math_render import _INLINE_RE, _DISPLAY_RE, render_math_png_bytes

_THEMES = {
    "light": {"bg": (255, 255, 255), "text": (17, 17, 17), "accent": (60, 60, 60)},
    "dark": {"bg": (24, 24, 27), "text": (250, 250, 250), "accent": (180, 180, 180)},
}


def _set_slide_bg(slide, rgb: tuple[int, int, int]) -> None:
    from pptx.dml.color import RGBColor

    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = RGBColor(*rgb)


def _add_title_slide(prs: Presentation, paper: ParsedPaper, theme: dict) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _set_slide_bg(slide, theme["bg"])
    box = slide.shapes.add_textbox(Inches(0.8), Inches(2.2), Inches(11.5), Inches(2))
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = paper.title or "Untitled"
    p.font.size = Pt(32)
    p.font.bold = True
    p.alignment = PP_ALIGN.CENTER
    from pptx.dml.color import RGBColor

    p.font.color.rgb = RGBColor(*theme["text"])
    sub = tf.add_paragraph()
    sub.text = ", ".join(paper.authors or [])
    sub.font.size = Pt(16)
    sub.font.color.rgb = RGBColor(*theme["accent"])
    sub.alignment = PP_ALIGN.CENTER
    foot = tf.add_paragraph()
    foot.text = f"Exported from Know — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    foot.font.size = Pt(11)
    foot.font.color.rgb = RGBColor(*theme["accent"])
    foot.alignment = PP_ALIGN.CENTER


def _add_bullet_slide(
    prs: Presentation,
    title: str,
    bullets: list[str],
    theme: dict,
    *,
    dense: bool = False,
) -> None:
    if not bullets:
        return
    chunk = 8 if dense else 5
    for i in range(0, len(bullets), chunk):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        _set_slide_bg(slide, theme["bg"])
        tb = slide.shapes.add_textbox(Inches(0.6), Inches(0.5), Inches(12), Inches(0.8))
        tb.text_frame.text = title if i == 0 else f"{title} (cont.)"
        tb.text_frame.paragraphs[0].font.size = Pt(24)
        from pptx.dml.color import RGBColor

        tb.text_frame.paragraphs[0].font.color.rgb = RGBColor(*theme["text"])
        body = slide.shapes.add_textbox(Inches(0.8), Inches(1.4), Inches(11.5), Inches(5.5))
        tf = body.text_frame
        tf.word_wrap = True
        for j, b in enumerate(bullets[i : i + chunk]):
            para = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
            para.text = b[:500]
            para.font.size = Pt(14 if dense else 16)
            para.font.color.rgb = RGBColor(*theme["text"])
            para.level = 0


def _plain_text(s: str) -> str:
    s = _DISPLAY_RE.sub(lambda m: m.group(1), s or "")
    s = _INLINE_RE.sub(lambda m: m.group(1), s or "")
    return re.sub(r"\s+", " ", s).strip()


def render_pptx(export_row: dict, paper: ParsedPaper, cache: dict) -> tuple[bytes, str, str]:
    options = export_row.get("options") or {}
    pptx_opts = options.get("pptx") or {}
    theme_name = pptx_opts.get("theme", "light")
    dense = pptx_opts.get("dense", False)
    theme = _THEMES.get(theme_name, _THEMES["light"])

    sections = export_row.get("sections") or []
    content = gather_export_context(paper, export_row["user_id"], sections)

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    _add_title_slide(prs, paper, theme)

    for key in sections:
        label = SECTION_LABELS.get(key, key)
        if key == "summary":
            s = content.get("summary") or {}
            bullets = []
            if s.get("overview"):
                bullets.append(_plain_text(s["overview"]))
            if s.get("tl_dr"):
                bullets.append(f"TL;DR: {_plain_text(s['tl_dr'])}")
            for c in s.get("key_contributions") or []:
                bullets.append(_plain_text(c))
            _add_bullet_slide(prs, label, bullets, theme, dense=dense)
            for sub, stitle in [
                ("methodology", "Methodology"),
                ("main_results", "Results"),
                ("discussion", "Discussion"),
            ]:
                if s.get(sub):
                    _add_bullet_slide(prs, stitle, [_plain_text(s[sub])], theme, dense=dense)

        elif key == "qa":
            items = []
            for session in content.get("qa") or []:
                for item in session.get("items") or session.get("questions") or []:
                    items.append(
                        f"Q: {_plain_text(item.get('question', ''))}\nA: {_plain_text(item.get('answer', ''))}"
                    )
            if items:
                _add_bullet_slide(prs, label, items, theme, dense=dense)
            else:
                _add_bullet_slide(prs, label, ["No Q&A yet."], theme, dense=dense)

        elif key in ("notes", "highlights", "selection", "cross"):
            entries = []
            if key == "notes":
                for n in content.get("notes") or []:
                    entries.append(_plain_text(n.get("text") or n.get("content") or ""))
            elif key == "highlights":
                for h in content.get("highlights") or []:
                    entries.append(f"{h.get('color', '')}: {h.get('selected_text', '')}")
            elif key == "selection":
                for item in content.get("selection") or []:
                    entries.append(_plain_text(item.get("body") or item.get("result") or ""))
            else:
                for item in content.get("cross") or []:
                    entries.append(f"Q: {_plain_text(item.get('question', ''))}")
            _add_bullet_slide(
                prs, label, entries or [f"No {label.lower()} yet."], theme, dense=dense
            )

        elif key == "figures":
            metas = (content.get("figures") or {}).get("meta") or paper.figures or []
            for f in metas:
                fid = f.get("id") if isinstance(f, dict) else getattr(f, "id", None)
                slide = prs.slides.add_slide(prs.slide_layouts[6])
                _set_slide_bg(slide, theme["bg"])
                path = get_figure_path(paper.id, fid) if fid else None
                if path and path.exists():
                    slide.shapes.add_picture(str(path), Inches(0.5), Inches(1), height=Inches(5))
                cap = f.get("caption") if isinstance(f, dict) else getattr(f, "caption", "")
                box = slide.shapes.add_textbox(Inches(6.5), Inches(1), Inches(6), Inches(5))
                box.text_frame.text = cap or "Figure"
            if not metas:
                _add_bullet_slide(prs, label, ["No figures yet."], theme, dense=dense)

        else:
            _add_bullet_slide(prs, label, [f"See {label} in Know."], theme, dense=dense)

    buf = io.BytesIO()
    prs.save(buf)
    slug = slugify_title(paper.title)
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"Know-export-{slug}-{date}.pptx"
    return buf.getvalue(), (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ), filename
