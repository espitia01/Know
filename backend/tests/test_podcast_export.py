"""Podcast export validator and stitch tests."""

from __future__ import annotations

import sys
from unittest.mock import AsyncMock, patch

import pytest

from app.services.exports.podcast_render import (
    build_section_text,
    filter_segments,
    validate_podcast_script,
)


def test_forbidden_phrase_triggers_retry_logic():
    bad = [{"segment": "intro", "text": "Let's dive in to the methodology of this paper today."}]
    ok, reason = validate_podcast_script(bad)
    assert not ok
    assert "forbidden" in reason

    good = [
        {"segment": "intro", "text": "This paper by Smith examines gradient descent convergence under noise."},
        {"segment": "section:summary", "text": "The authors show that the reported effect is modest but statistically robust across three held-out datasets."},
        {"segment": "outro", "text": "In summary, the contribution is a careful empirical study with explicit limitations on generalization."},
    ]
    ok2, _ = validate_podcast_script(good)
    assert ok2


def test_filter_segments_drops_short():
    segs = [
        {"segment": "intro", "text": "Too short"},
        {"segment": "section:summary", "text": "This segment has enough words to pass the minimum length filter comfortably."},
    ]
    out = filter_segments(segs)
    assert len(out) == 1


def test_build_section_text_prepare():
    text = build_section_text(
        "prepare",
        {},
        {"prepare": {"definitions": [{"term": "SGD", "definition": "Stochastic gradient descent"}]}},
    )
    assert "SGD" in text


@pytest.mark.asyncio
@pytest.mark.skipif(sys.version_info >= (3, 13), reason="pydub requires audioop (removed in 3.13)")
async def test_stitch_mock_tts():
    from app.models.schemas import ParsedPaper
    from app.services.exports.podcast_render import render_podcast

    fake_mp3 = b"\xff\xfb\x90\x00" + b"\x00" * 100

    paper = ParsedPaper(id="p", title="T", authors=[])
    export_row = {"user_id": "u", "options": {"podcast": {"voice": "onyx"}}}
    segments = [
        {"segment": "intro", "text": "Opening remarks about the paper structure and main contribution for listeners."},
        {"segment": "outro", "text": "Closing summary of the key takeaway and limitations noted by the authors."},
    ]

    with patch(
        "app.services.exports.podcast_render.synthesize_segment",
        new=AsyncMock(return_value=fake_mp3),
    ):
        with patch("pydub.AudioSegment") as mock_seg:
            inst = mock_seg.from_mp3.return_value
            mock_seg.empty.return_value = inst
            inst.__iadd__ = lambda self, other: self
            inst.export = lambda buf, **kw: buf.write(b"mp3data")
            type(inst).__len__ = lambda self: 480000

            _data, ctype, filename, dur = await render_podcast(export_row, paper, segments)
            assert ctype == "audio/mpeg"
            assert filename.endswith(".mp3")
            assert dur > 0
