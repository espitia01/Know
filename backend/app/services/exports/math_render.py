"""Math rendering helpers for export pipelines."""

from __future__ import annotations

import io
import re
from functools import lru_cache

_DISPLAY_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_INLINE_RE = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)")


def render_math_html(text: str) -> str:
    """Replace $...$ / $$...$$ spans with MathML via latex2mathml."""
    if not text:
        return ""

    try:
        from latex2mathml.converter import convert as latex2mathml
    except ImportError:
        return text

    def _display(m: re.Match) -> str:
        tex = m.group(1).strip()
        try:
            mathml = latex2mathml(tex, display="block")
            return f'<div class="math-display">{mathml}</div>'
        except Exception:
            return f"<pre>{tex}</pre>"

    def _inline(m: re.Match) -> str:
        tex = m.group(1).strip()
        try:
            mathml = latex2mathml(tex, display="inline")
            return f'<span class="math-inline">{mathml}</span>'
        except Exception:
            return tex

    out = _DISPLAY_RE.sub(_display, text)
    out = _INLINE_RE.sub(_inline, out)
    return out


@lru_cache(maxsize=256)
def render_math_png_bytes(tex: str, *, fontsize: float = 14.0) -> bytes:
    """Render LaTeX to PNG bytes for PPTX embedding."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(0.01, 0.01))
    fig.patch.set_alpha(0.0)
    text_obj = fig.text(0, 0, f"${tex}$", fontsize=fontsize)
    fig.canvas.draw()
    bbox = text_obj.get_window_extent(fig.canvas.get_renderer()).expanded(1.1, 1.3)
    w, h = bbox.width, bbox.height
    dpi = 150
    fig.set_size_inches(w / dpi, h / dpi)
    text_obj.set_position((0, 0))
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, transparent=True, bbox_inches="tight", pad_inches=0.02)
    plt.close(fig)
    return buf.getvalue()


def strip_math_to_plain(text: str) -> str:
    """Speak math aloud — strip delimiters, leave readable tokens."""
    if not text:
        return ""
    out = _DISPLAY_RE.sub(lambda m: m.group(1).strip(), text)
    out = _INLINE_RE.sub(lambda m: m.group(1).strip(), out)
    return out
