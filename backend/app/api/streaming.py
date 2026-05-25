"""Server-Sent Events streaming endpoints for analysis features.

These routes give the chat-like progressive rendering for selection
(explain / derive / follow-up) and figure analysis. They differ from
the batch JSON routes in two ways:

  1. The model returns **markdown prose** instead of structured JSON.
     This keeps the streaming surface simple — every chunk is text the
     client can hand straight to Streamdown — and dodges the "Mistral
     vision returned prose, not JSON" failures that plagued the batch
     path.
  2. We use ``provider.stream_complete`` / ``stream_complete_with_image``
     so the user sees tokens as they arrive instead of waiting on a
     single HTTP roundtrip. This is the "ChatGPT-style" feel the
     product team has asked for.

The SSE envelope mirrors what ``frontend/src/lib/selectionSse.ts``
already understands::

    data: {"type":"chunk","text":"..."}
    data: {"type":"done","full_text":"..."}
    data: {"type":"error","message":"..."}

Each event ends with ``\\n\\n`` per the SSE spec.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..auth import require_auth
from ..gating import (
    canonicalize_model,
    check_feature_access,
    enforce_model,
    get_usage_multiplier,
    release_usage,
    reserve_usage,
    resolve_fast_model,
)
from ..services.llm import (
    LATEX_FORMAT_INSTRUCTIONS,
    LLMProviderError,
    _make_provider,
    _resize_image_b64,
    _sanitize_user_text,
    get_fast_provider,
)
from ..services.pdf_parser import (
    append_capped,
    get_paper,
    load_figure_png_bytes,
    mutate_paper,
    paper_prompt_text,
)
from ..api.papers import _validate_figure_id, _validate_id, _verify_paper_owner

router = APIRouter(prefix="/api/papers", tags=["streaming"])
logger = logging.getLogger(__name__)


def _sse_event(payload: dict) -> bytes:
    """Format a JSON payload as one SSE event."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def _resolve_model(user_id: str, body: dict) -> str:
    """Pick a model: explicit override → user's fast model → server default."""
    requested = body.get("model") if isinstance(body, dict) else None
    if isinstance(requested, str) and requested.strip():
        slug = canonicalize_model(requested.strip()) or requested.strip()
        return enforce_model(user_id, slug)
    return resolve_fast_model(user_id)


# ---------------------------------------------------------------------------
# Selection streaming
# ---------------------------------------------------------------------------


def _selection_system_prompt() -> str:
    return (
        "You are an expert science educator helping a student understand a "
        "passage from an academic paper.\n\n"
        "Output rules:\n"
        "- Reply in clean markdown — no JSON, no code fences around the whole "
        "response, no role labels.\n"
        "- Use $...$ for inline math and $$...$$ for display math. Never emit "
        "Unicode math (σ, π, ∂, ⟂, etc.) — always LaTeX (\\sigma, \\pi, "
        "\\partial, \\perp).\n"
        "- Never split a single equation into character-per-line columns.\n"
        "- Headings are markdown `##` / `###`; bullets use `-`.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )


def _selection_user_prompt(
    paper_text: str, selected_text: str, action: str, question: str | None
) -> str:
    if action == "derive":
        return (
            "Reconstruct the derivation of the result described in this passage step by step.\n\n"
            "If the passage contains math, derive it mathematically; each step is a heading "
            "`### Step N` followed by the LaTeX expression on its own line and a short "
            "explanation paragraph below.\n"
            "If the passage is non-mathematical, derive the *argument* — premise → "
            "inference → conclusion — using the same `### Step N` structure.\n"
            "End with a `## Result` section that states the final expression / conclusion.\n\n"
            f"Selected text:\n\"\"\"{selected_text}\"\"\"\n\n"
            f"Paper context:\n{paper_text[:6000]}"
        )
    if action == "followup" and question:
        return (
            "The user has a follow-up question about the previous selection.\n\n"
            f"Selected text:\n\"\"\"{selected_text}\"\"\"\n\n"
            f"Follow-up question: {question}\n\n"
            f"Paper context:\n{paper_text[:6000]}\n\n"
            "Answer the question directly in 2–4 paragraphs of markdown."
        )
    return (
        "Explain the following passage clearly and thoroughly. If it ends in a "
        "question mark or otherwise asks something, answer it directly using the "
        "paper as context. Otherwise unpack jargon, walk the logic step by step, "
        "and add the broader implications.\n\n"
        f"Selected text:\n\"\"\"{selected_text}\"\"\"\n\n"
        f"Paper context:\n{paper_text[:6000]}\n\n"
        "Reply with markdown — start with a 1-sentence TL;DR in bold, then a "
        "few paragraphs of explanation. End with a `### Why it matters` section "
        "if there's something genuinely non-obvious to say there."
    )


def _persist_selection_streamed(
    paper_id: str,
    user_id: str,
    *,
    action: str,
    selected_text: str,
    question: str | None,
    explanation: str,
    model: str,
) -> None:
    """Append the streamed selection to the paper's cached_analysis history."""
    payload = {
        "action": action if action != "assumptions" else "explain",
        "selected_text": selected_text,
        "question": question,
        "explanation": explanation,
        "model": model,
        "streaming": False,
    }
    try:
        mutate_paper(
            paper_id,
            user_id,
            lambda p: append_capped(p.cached_analysis, "selections", payload),
        )
    except Exception:
        logger.exception("Failed to persist streamed selection for %s", paper_id)


@router.post("/{paper_id}/selection-stream")
async def selection_stream(
    paper_id: str,
    body: dict = Body(default={}),
    user_id: str = Depends(require_auth),
):
    """Stream selection (explain / derive / follow-up) as markdown SSE."""
    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    selected_text = (body.get("selected_text") or "").strip()
    if not selected_text and not body.get("image_base64"):
        raise HTTPException(status_code=400, detail="No selected_text or image provided")

    action = (body.get("action") or "explain").strip().lower()
    if action not in ("explain", "derive", "followup", "assumptions"):
        action = "explain"
    question = (body.get("question") or "").strip() or None
    image_b64 = body.get("image_base64")

    model_used = _resolve_model(user_id, body)
    provider = _make_provider(model_used)

    selected_clean = _sanitize_user_text(selected_text or "Equation selected from PDF.")
    paper_clean = _sanitize_user_text(paper_prompt_text(paper) or "", max_chars=6000)
    system = _selection_system_prompt()
    user_prompt = _selection_user_prompt(paper_clean, selected_clean, action, question)

    token = reserve_usage(
        user_id, paper_id, "selection", model=model_used,
        count=get_usage_multiplier(user_id),
    )

    async def event_stream() -> AsyncIterator[bytes]:
        accumulated = ""
        released = False
        try:
            yield _sse_event({"type": "start", "model": model_used, "action": action})

            if image_b64 and hasattr(provider, "stream_complete_with_image"):
                resized = _resize_image_b64(image_b64)
                stream_iter = provider.stream_complete_with_image(  # type: ignore[attr-defined]
                    system
                    + "\n\nThe image attached is a screenshot of the EXACT selection from "
                    "the PDF; it is the ground-truth content. Prefer the image whenever the "
                    "text below is corrupted.",
                    user_prompt,
                    resized,
                    max_tokens=3000,
                )
            elif image_b64 and hasattr(provider, "complete_with_image"):
                # Vision model with no streaming endpoint (Mistral): fall
                # back to a single batch call, then emit it in one chunk
                # so the client still receives a `chunk` then `done`.
                resized = _resize_image_b64(image_b64)
                full = await provider.complete_with_image(  # type: ignore[attr-defined]
                    system, user_prompt, resized, max_tokens=3000,
                )
                if full:
                    accumulated = full
                    yield _sse_event({"type": "chunk", "text": full})
                yield _sse_event({"type": "done", "full_text": accumulated})
                _persist_selection_streamed(
                    paper_id, user_id,
                    action=action, selected_text=selected_clean,
                    question=question, explanation=accumulated, model=model_used,
                )
                return
            else:
                stream_iter = provider.stream_complete(system, user_prompt, max_tokens=3000)

            async for chunk in stream_iter:
                if not chunk:
                    continue
                accumulated += chunk
                yield _sse_event({"type": "chunk", "text": chunk})

            yield _sse_event({"type": "done", "full_text": accumulated})
            _persist_selection_streamed(
                paper_id, user_id,
                action=action, selected_text=selected_clean,
                question=question, explanation=accumulated, model=model_used,
            )
        except LLMProviderError as exc:
            if not released:
                release_usage(token)
                released = True
            yield _sse_event({"type": "error", "message": exc.message})
        except asyncio.CancelledError:
            if not released and not accumulated:
                release_usage(token)
                released = True
            raise
        except Exception as exc:
            logger.exception("selection-stream failed for %s", paper_id)
            if not released and not accumulated:
                release_usage(token)
                released = True
            yield _sse_event({"type": "error", "message": str(exc) or "Selection failed."})
        finally:
            # If we never produced any tokens, the user got nothing — refund.
            if not released and not accumulated:
                release_usage(token)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Figure analysis streaming
# ---------------------------------------------------------------------------


def _figure_system_prompt() -> str:
    return (
        "You are an expert science educator analyzing figures from academic papers. "
        "Reply in clean markdown — no JSON, no role labels.\n\n"
        "Use $...$ for inline math and $$...$$ for display math; never Unicode math.\n\n"
        + LATEX_FORMAT_INSTRUCTIONS
    )


def _figure_user_prompt(paper_text: str, question: str) -> str:
    if question.strip():
        return (
            f"Question about this figure: {question}\n\n"
            f"Paper context:\n{paper_text[:6000]}\n\n"
            "Answer the question directly using the figure and the paper. Use "
            "section headings where helpful and finish with a one-sentence takeaway."
        )
    return (
        f"Paper context:\n{paper_text[:6000]}\n\n"
        "Analyze this figure thoroughly. Cover: what it shows, what the axes / "
        "labels mean, the key observations, the methodology it illustrates, how "
        "it relates to the paper's argument, and end with a short bold takeaway."
    )


def _persist_figure_streamed(
    paper_id: str,
    user_id: str,
    *,
    figure_id: str,
    question: str,
    description: str,
    model: str,
) -> None:
    payload = {
        "figure_id": figure_id,
        "question": question,
        "description": description,
        "answer": description if question.strip() else "",
        "key_observations": [],
        "relation_to_paper": "",
        "model": model,
    }
    try:
        mutate_paper(
            paper_id,
            user_id,
            lambda p: append_capped(p.cached_analysis, "figure_analyses", payload),
        )
    except Exception:
        logger.exception("Failed to persist streamed figure analysis for %s", paper_id)


@router.post("/{paper_id}/figure-qa-stream")
async def figure_qa_stream(
    paper_id: str,
    body: dict = Body(default={}),
    user_id: str = Depends(require_auth),
):
    """Stream figure analysis as markdown SSE."""
    check_feature_access(user_id, "figures")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    fig_id = (body.get("figure_id") or "").strip()
    question = (body.get("question") or "").strip()[:2000]
    if not fig_id:
        raise HTTPException(status_code=400, detail="No figure_id provided")
    _validate_figure_id(fig_id)

    from ..services.pdf_parser import load_ocr_image_bytes
    from ..services.ocr_mistral import validate_ocr_image_id

    fig_bytes = None
    try:
        validate_ocr_image_id(fig_id)
        fig_bytes = load_ocr_image_bytes(paper_id, fig_id, user_id)
    except ValueError:
        pass
    if not fig_bytes:
        fig_bytes = load_figure_png_bytes(paper_id, fig_id, user_id)
    if not fig_bytes:
        raise HTTPException(status_code=404, detail="Figure not found")

    image_b64 = base64.b64encode(fig_bytes).decode("utf-8")
    image_b64 = _resize_image_b64(image_b64)

    model_used = _resolve_model(user_id, body)
    provider = _make_provider(model_used)
    if not hasattr(provider, "complete_with_image"):
        raise HTTPException(
            status_code=400,
            detail=f"Selected model '{model_used}' does not support figure analysis. Pick a vision-capable model.",
        )

    paper_clean = _sanitize_user_text(paper_prompt_text(paper) or "", max_chars=6000)
    system = _figure_system_prompt()
    user_prompt = _figure_user_prompt(paper_clean, question)

    token = reserve_usage(
        user_id, paper_id, "qa", model=model_used,
        count=get_usage_multiplier(user_id),
    )

    async def event_stream() -> AsyncIterator[bytes]:
        accumulated = ""
        released = False
        try:
            yield _sse_event({"type": "start", "model": model_used, "figure_id": fig_id})

            if hasattr(provider, "stream_complete_with_image"):
                stream_iter = provider.stream_complete_with_image(  # type: ignore[attr-defined]
                    system, user_prompt, image_b64, max_tokens=4000,
                )
                async for chunk in stream_iter:
                    if not chunk:
                        continue
                    accumulated += chunk
                    yield _sse_event({"type": "chunk", "text": chunk})
            else:
                # Mistral / OpenAI vision without streaming → batch then chunk-once.
                full = await provider.complete_with_image(  # type: ignore[attr-defined]
                    system, user_prompt, image_b64, max_tokens=4000,
                )
                if full:
                    accumulated = full
                    yield _sse_event({"type": "chunk", "text": full})

            yield _sse_event({"type": "done", "full_text": accumulated})
            _persist_figure_streamed(
                paper_id, user_id,
                figure_id=fig_id, question=question,
                description=accumulated, model=model_used,
            )
        except LLMProviderError as exc:
            if not released:
                release_usage(token)
                released = True
            yield _sse_event({"type": "error", "message": exc.message})
        except asyncio.CancelledError:
            if not released and not accumulated:
                release_usage(token)
                released = True
            raise
        except Exception as exc:
            logger.exception("figure-qa-stream failed for %s", paper_id)
            if not released and not accumulated:
                release_usage(token)
                released = True
            yield _sse_event({"type": "error", "message": str(exc) or "Figure analysis failed."})
        finally:
            if not released and not accumulated:
                release_usage(token)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
