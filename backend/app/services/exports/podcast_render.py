"""Podcast export: script validation, TTS, stitching."""

from __future__ import annotations

import asyncio
import io
import logging
import re
from datetime import datetime, timezone

import httpx

from ...config import settings
from ...models.schemas import ParsedPaper
from .content import gather_export_context, slugify_title

logger = logging.getLogger(__name__)

PODCAST_VOICES = frozenset({"onyx", "nova", "alloy"})
FORBIDDEN_PHRASES = [
    "yeah", "right?", "so...", "basically", "honestly", "totally",
    "kind of", "you know", "let's dive in", "deep dive", "wow",
    "doesn't that blow your mind", "we're going to look at", "we both noticed",
]

_lint_podcast_forbidden = 0


def lint_podcast_forbidden_count() -> int:
    return _lint_podcast_forbidden


def validate_podcast_script(segments: list[dict]) -> tuple[bool, str]:
    """Return (ok, reason)."""
    global _lint_podcast_forbidden
    if not segments:
        return False, "empty"
    texts = [s.get("text", "") for s in segments if len(s.get("text", "")) >= 20]
    if not texts:
        return False, "too_short"
    joined = " ".join(texts).lower()
    for phrase in FORBIDDEN_PHRASES:
        if phrase in joined:
            _lint_podcast_forbidden += 1
            return False, f"forbidden:{phrase}"
    first_words = [t.split()[0].lower() for t in texts if t.split()]
    if len(first_words) >= 3:
        from collections import Counter

        common, count = Counter(first_words).most_common(1)[0]
        if count > 1 and count / len(first_words) > 0.2:
            return False, f"repetitive:{common}"
    return True, "ok"


def filter_segments(segments: list[dict]) -> list[dict]:
    return [s for s in segments if len((s.get("text") or "").strip()) >= 20]


async def synthesize_segment(text: str, voice: str) -> bytes:
    api_key = (settings.openai_api_key or "").strip()
    if not api_key:
        raise RuntimeError("openai_unconfigured")
    if len(text) > 4000:
        raise RuntimeError("segment_too_long")
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": "tts-1", "input": text, "voice": voice, "response_format": "mp3"},
        )
    if resp.status_code != 200:
        raise RuntimeError(f"tts_failed:{resp.status_code}")
    return resp.content


def _silence_ms(prev_id: str, next_id: str) -> int:
    if prev_id.startswith("intro") or next_id == "outro":
        return 700
    base_prev = prev_id.split(":")[0]
    base_next = next_id.split(":")[0]
    if base_prev == base_next and ":a" in prev_id:
        return 180
    return 450


async def render_podcast(
    export_row: dict,
    paper: ParsedPaper,
    segments: list[dict],
) -> tuple[bytes, str, str, float]:
    """Return (mp3_bytes, content_type, filename, duration_s)."""
    from pydub import AudioSegment
    from pydub.effects import normalize

    options = export_row.get("options") or {}
    voice = (options.get("podcast") or {}).get("voice", "onyx")
    if voice not in PODCAST_VOICES:
        voice = "onyx"

    sem = asyncio.Semaphore(6)

    async def _one(seg: dict) -> tuple[str, bytes]:
        async with sem:
            audio = await synthesize_segment(seg["text"], voice)
            return seg.get("segment", ""), audio

    parts = await asyncio.gather(*[_one(s) for s in segments])
    combined = AudioSegment.empty()
    prev_id = ""
    for seg_id, mp3 in parts:
        clip = AudioSegment.from_mp3(io.BytesIO(mp3))
        if prev_id:
            combined += AudioSegment.silent(duration=_silence_ms(prev_id, seg_id))
        combined += clip
        prev_id = seg_id
    if prev_id:
        combined += AudioSegment.silent(duration=700)

    combined = normalize(combined)
    out = io.BytesIO()
    combined.export(out, format="mp3", bitrate="96k")
    duration_s = len(combined) / 1000.0

    slug = slugify_title(paper.title)
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"Know-podcast-{slug}-{date}.mp3"
    return out.getvalue(), "audio/mpeg", filename, duration_s


def build_section_text(key: str, data: dict, content: dict) -> str:
    """Plain-text summary of a section for the script prompt."""
    if key == "summary":
        s = content.get("summary") or {}
        parts = [s.get("overview", ""), s.get("methodology", ""), s.get("main_results", "")]
        return " ".join(p for p in parts if p)
    if key == "qa":
        lines = []
        for session in content.get("qa") or []:
            for item in session.get("items") or []:
                lines.append(f"Question: {item.get('question', '')} Answer: {item.get('answer', '')}")
        return " ".join(lines)
    return str(data)[:3000]
