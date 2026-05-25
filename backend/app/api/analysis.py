"""API routes for AI-powered paper analysis.

Every route follows the same reservation contract:

    token = reserve_usage(user_id, paper_id, action, model=..., count=N)
    try:
        <LLM / streaming / side effects>
    except Exception:
        release_usage(token)
        raise

``reserve_usage`` atomically debits the user's daily total, per-model daily
sub-budget, and per-paper action counter BEFORE any expensive work, so
bursts can't waste LLM tokens and concurrent requests can't race past a cap
(see migration 008). ``release_usage`` rolls the reservation back when the
downstream work fails so users aren't debited for a call that produced
nothing.
"""

from __future__ import annotations

import asyncio
import logging
import time
from fastapi import APIRouter, HTTPException, Depends, Request, Body
from fastapi.responses import StreamingResponse

from ..models.schemas import (
    AssumptionsResponse,
    DerivationExercise,
    ExplainRequest,
    ExplainResponse,
    PreReadingAnalysis,
    QARequest,
    QAResponse,
    QAItem,
)
from ..services.llm import (
    analyze_paper,
    analyze_selection,
    analyze_figure,
    answer_questions,
    answer_questions_multi,
    explain_term,
    extract_assumptions,
    find_skipped_steps,
    generate_derivation_exercise,
    summarize_paper,
    summarize_paper_lite,
    get_fast_provider,
    get_provider,
    _coerce_assumptions,
    _get_figure_prompt,
    _get_selection_prompt,
    _resize_image_b64,
    _normalize_latex_delimiters,
    _safe_parse_json,
)
from ..services.pdf_parser import (
    append_capped,
    append_cached_analysis_local,
    get_paper,
    get_figure_path,
    load_figure_png_bytes,
    mutate_paper,
    paper_prompt_text,
)
from ..services.citation_resolve import (
    bibliography_to_prior_work_entries,
    build_prior_work_topics_from_clusters,
    enrich_prior_work_from_bibliography,
    finalize_pre_reading_urls,
    merge_reference_summaries,
    normalize_prior_row_hydrated,
)
from ..services.reference_extract import extract_references_section
from ..services.db import append_selection as append_selection_db
from ..services.db import append_qa_session as append_qa_session_db
from ..auth import require_auth
from ..gating import (
    check_feature_access,
    reserve_usage,
    release_usage,
    resolve_analysis_model,
    resolve_fast_model,
    get_usage_multiplier,
    canonicalize_model,
    enforce_model,
)
from ..api.papers import _validate_id, _validate_figure_id, _verify_paper_owner

router = APIRouter(prefix="/api/papers", tags=["analysis"])
logger = logging.getLogger(__name__)


def _is_usable_pre_reading(payload: dict) -> bool:
    return bool(
        payload.get("definitions")
        or payload.get("research_questions")
        or payload.get("concepts")
    )


@router.post("/{paper_id}/analyze", response_model=PreReadingAnalysis)
async def analyze(paper_id: str, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "prepare")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    token = reserve_usage(
        user_id, paper_id, "api_call", model=resolve_analysis_model(user_id)
    )
    analysis_payload = None
    try:
        result = await analyze_paper(paper_prompt_text(paper), user_id=user_id)
        raw_txt = paper_prompt_text(paper) or ""
        bib_blob = extract_references_section(raw_txt, max_chars=26000)
        bib_rows = bibliography_to_prior_work_entries(bib_blob)
        # Some PDFs place references only in the last pages; extracting from the tail
        # recovers bibliography when an earlier "References" false positive trims wrong.
        if len(bib_rows) <= 1 and len(raw_txt.strip()) > 8000:
            tail = raw_txt[-min(len(raw_txt), 45000) :]
            alt_blob = extract_references_section(tail, max_chars=26000)
            if alt_blob.strip() and alt_blob.strip() != bib_blob.strip():
                alt_rows = bibliography_to_prior_work_entries(alt_blob)
                if len(alt_rows) > len(bib_rows):
                    bib_blob, bib_rows = alt_blob, alt_rows

        if len(bib_rows) >= 1:
            merge_reference_summaries(bib_rows, result.get("reference_summaries"))
            hydrated = [normalize_prior_row_hydrated(r) for r in bib_rows]
            enrich_prior_work_from_bibliography(hydrated, bib_blob)
            topics = build_prior_work_topics_from_clusters(hydrated, result.get("reference_clusters"))
            result["prior_work"] = hydrated
            result["prior_work_topics"] = topics
            try:
                await finalize_pre_reading_urls(result)
            except Exception:
                logger.warning(
                    "finalize_pre_reading_urls failed for paper %s (links may be partial)",
                    paper_id,
                    exc_info=True,
                )
        else:
            result["prior_work"] = []
            result["prior_work_topics"] = []

        analysis = PreReadingAnalysis(
            definitions=result.get("definitions", []),
            research_questions=result.get("research_questions", []),
            prior_work=result.get("prior_work", []),
            prior_work_topics=result.get("prior_work_topics", []),
            concepts=result.get("concepts", []),
        )
        analysis_payload = analysis.model_dump()
        return analysis
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(
            status_code=503,
            detail={
                "code": "prepare_empty",
                "message": (
                    "Pre-reading analysis could not be parsed. "
                    "Try again or switch to another model in Settings."
                ),
                "model": resolve_analysis_model(user_id),
            },
        )
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Analysis failed. Please try again.")
    finally:
        if analysis_payload is not None and _is_usable_pre_reading(analysis_payload):
            try:
                # Per F-HYDRATION: persist paid-for output even if a
                # post-LLM response path later fails.
                mutate_paper(
                    paper_id,
                    user_id,
                    lambda p: p.cached_analysis.__setitem__("pre_reading", analysis_payload),
                )
            except Exception:
                logger.exception("Failed to persist pre_reading for %s", paper_id)


@router.post("/{paper_id}/selection")
async def selection_analysis(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Analyze user-highlighted text from the PDF viewer."""
    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    selected_text = body.get("selected_text", "").strip()[:10000]
    question = (body.get("question") or "").strip()[:2000]
    action = body.get("action", "explain")
    # PDF page regions are persisted so the highlight underline can be
    # repainted after a refresh. The frontend computes pct geometry once
    # at action time; we don't validate the shape beyond capping length.
    regions_in = body.get("regions")
    sanitized_regions: list[dict] | None = None
    if isinstance(regions_in, list) and len(regions_in) <= 32:
        sanitized_regions = []
        for r in regions_in:
            if not isinstance(r, dict):
                continue
            try:
                sanitized_regions.append({
                    "pageNum": int(r["pageNum"]),
                    "xPct": float(r["xPct"]),
                    "yPct": float(r["yPct"]),
                    "wPct": float(r["wPct"]),
                    "hPct": float(r["hPct"]),
                })
            except (KeyError, TypeError, ValueError):
                continue
        if not sanitized_regions:
            sanitized_regions = None
    # Optional vision payload: a base64-encoded PNG of the rendered selection,
    # captured client-side when the PDF text layer mangles equation glyphs.
    image_b64 = body.get("image_base64")
    if isinstance(image_b64, str):
        image_b64 = image_b64.strip()
        # Strip a data-URL prefix if the client included one.
        if image_b64.startswith("data:image"):
            comma = image_b64.find(",")
            if comma >= 0:
                image_b64 = image_b64[comma + 1 :]
        # Hard cap (~6 MB encoded ≈ 4.5 MB binary) to keep prompts manageable.
        if len(image_b64) > 6_500_000:
            image_b64 = None
    else:
        image_b64 = None
    # Legacy "question" is folded into Explain; the standalone Ask
    # button was removed (its UX was a near-duplicate of Explain).
    # Anything else unknown also collapses to Explain so old clients
    # don't 4xx.
    if action == "question":
        action = "explain"
    if action == "assumptions":
        # Passage-level assumptions ride on Explain (paper-wide assumptions use `/assumptions`).
        action = "explain"
    if action not in ("explain", "derive", "followup"):
        action = "explain"
    if not selected_text and not image_b64:
        raise HTTPException(status_code=400, detail="No text selected")

    requested_model = body.get("model")
    if isinstance(requested_model, str) and requested_model.strip():
        model_used = enforce_model(
            user_id, canonicalize_model(requested_model.strip()) or requested_model.strip()
        )
    else:
        model_used = resolve_fast_model(user_id)

    token = reserve_usage(
        user_id, paper_id, "selection", model=model_used,
        count=get_usage_multiplier(user_id),
    )
    try:
        result = await analyze_selection(
            paper_prompt_text(paper),
            selected_text,
            action,
            user_id=user_id,
            image_b64=image_b64,
            model_override=model_used,
        )
        if question:
            # Per audit §11.3: keep selected_text identical to what the
            # server analyzed, and persist the user's short follow-up prompt
            # separately so hydration does not rewrite threaded entries.
            result["question"] = question
        if sanitized_regions:
            result["regions"] = sanitized_regions
        result["model"] = model_used
        # Per audit §7.1: append this JSONB item atomically in Postgres
        # instead of read-modify-writing the whole paper row.
        if not append_selection_db(paper_id, user_id, result):
            def _apply(p):
                append_capped(p.cached_analysis, "selections", result)
            mutate_paper(paper_id, user_id, _apply)
        else:
            append_cached_analysis_local(paper_id, user_id, "selections", result)
        return result
    except ValueError as exc:
        release_usage(token)
        logger.warning("Selection 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Selection analysis service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Selection analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Selection analysis failed. Please try again.")


@router.delete("/{paper_id}/selection")
async def delete_selection(
    paper_id: str, body: dict, user_id: str = Depends(require_auth),
):
    """Remove a previously stored selection from a paper.

    Selections live inside ``cached_analysis["selections"]`` and don't
    carry server-side IDs (they're free-form LLM results). We match on
    ``selected_text`` + ``action`` which is unique enough in practice
    that the client can round-trip safely: the user picks a highlight,
    we send both fields back, and we drop every matching entry. If no
    match is found we simply no-op instead of 404'ing — the client's
    view stays consistent without needing to retry.
    """
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    selected_text = (body.get("selected_text") or "").strip()
    action = body.get("action") or "explain"
    if not selected_text:
        raise HTTPException(status_code=400, detail="selected_text is required")

    holder: dict = {"ids": []}

    def _apply(p):
        items = p.cached_analysis.get("selections") or []
        removed_ids = {
            s.get("clientKey")
            for s in items
            if isinstance(s, dict)
            and (s.get("selected_text") or "").strip() == selected_text
            and (s.get("action") or "explain") == action
            and isinstance(s.get("clientKey"), str)
            and str(s.get("clientKey", "")).startswith("note_")
        }
        p.cached_analysis["selections"] = [
            s
            for s in items
            if not (
                isinstance(s, dict)
                and (s.get("selected_text") or "").strip() == selected_text
                and (s.get("action") or "explain") == action
            )
        ]
        if removed_ids:
            idset = {i for i in removed_ids if isinstance(i, str)}
            p.notes = [n for n in p.notes if n.get("id") not in idset]
        holder["ids"] = [i for i in removed_ids if isinstance(i, str)]

    try:
        mutate_paper(paper_id, user_id, _apply)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Paper not found")
    return {"ok": True, "removed_note_ids": holder["ids"]}


# /{paper_id}/selection-stream lived here through stages 1–7. It now
# runs on Next.js + AI SDK at the same path on the Vercel deploy
# (frontend/src/app/api/papers/[id]/selection-stream/route.ts). The
# anonymous trial flow uses /api/trial/selection-stream in main.py
# (which still streams from this Python service); authenticated
# selection streaming has moved entirely.


@router.post("/{paper_id}/explain", response_model=ExplainResponse)
async def explain(paper_id: str, req: ExplainRequest, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    token = reserve_usage(
        user_id, paper_id, "selection", model=resolve_analysis_model(user_id),
        count=get_usage_multiplier(user_id),
    )
    try:
        result = await explain_term(paper_prompt_text(paper), req.term, req.context, user_id=user_id)
        resp = ExplainResponse(
            term=result.get("term", req.term),
            explanation=result.get("explanation", "Could not generate explanation."),
            source=result.get("source", ""),
            in_paper=result.get("in_paper", False),
        )
        def _apply(p):
            append_capped(p.cached_analysis, "explains", resp.model_dump())
        mutate_paper(paper_id, user_id, _apply)
        return resp
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Explain failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Explain failed. Please try again.")


@router.post("/{paper_id}/skipped-steps")
async def skipped_steps(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    section_content = body.get("section", "")[:10000]

    token = reserve_usage(
        user_id, paper_id, "selection", model=resolve_analysis_model(user_id),
        count=get_usage_multiplier(user_id),
    )
    try:
        result = await find_skipped_steps(paper_prompt_text(paper), section_content, user_id=user_id)
        def _apply(p):
            append_capped(p.cached_analysis, "skipped_steps", result)
        mutate_paper(paper_id, user_id, _apply)
        return result
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis endpoint 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Skipped steps failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Skipped steps failed. Please try again.")


@router.post("/{paper_id}/assumptions", response_model=AssumptionsResponse)
async def assumptions(paper_id: str, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "assumptions")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    token = reserve_usage(
        user_id, paper_id, "api_call", model=resolve_analysis_model(user_id)
    )
    assumptions_payload = None
    try:
        result = await extract_assumptions(paper_prompt_text(paper), user_id=user_id)
        # If the LLM output was malformed and we fell through to the
        # safe-parse fallback (`{}`), do NOT cache an empty assumptions
        # list. Caching it creates the "disappearing assumptions" bug:
        # the UI reads `{assumptions: []}` from the server, renders the
        # "Extract Assumptions" empty state, and the user's re-extract
        # clicks keep hitting the same failure mode. Surfacing an error
        # here gives the panel a concrete "retry" target instead of a
        # silent loop.
        raw_items = result.get("assumptions") if isinstance(result, dict) else None
        normalized = _coerce_assumptions(raw_items)
        if len(normalized) == 0:
            release_usage(token)
            # Per F-HYDRATION: remember empty assumptions briefly so the
            # frontend does not hammer this endpoint every time the user
            # switches back to the paper.
            try:
                mutate_paper(
                    paper_id,
                    user_id,
                    lambda p: p.cached_analysis.__setitem__(
                        "assumptions_cooldown_until", int(time.time()) + 1800,
                    ),
                )
            except Exception:
                logger.exception("Failed to persist assumptions cooldown for %s", paper_id)
            logger.warning(
                "Assumptions extraction returned no items for paper %s (raw=%s)",
                paper_id, type(result).__name__,
            )
            raise HTTPException(
                status_code=502,
                detail="The analysis model didn't return usable assumptions. Please try again.",
            )
        resp = AssumptionsResponse(assumptions=normalized)
        assumptions_payload = resp.model_dump()
        return resp
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis endpoint 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Assumptions extraction failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Assumptions extraction failed. Please try again.")
    finally:
        if assumptions_payload is not None:
            try:
                # Per F-HYDRATION: persist paid-for assumptions even if a
                # later response/serialization step fails.
                mutate_paper(
                    paper_id,
                    user_id,
                    lambda p: p.cached_analysis.__setitem__("assumptions", assumptions_payload),
                )
            except Exception:
                logger.exception("Failed to persist assumptions for %s", paper_id)


@router.post("/{paper_id}/derivation/exercise", response_model=DerivationExercise)
async def derivation_exercise(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    section_content = body.get("section", "")[:10000]

    token = reserve_usage(
        user_id, paper_id, "selection", model=resolve_analysis_model(user_id),
        count=get_usage_multiplier(user_id),
    )
    try:
        result = await generate_derivation_exercise(paper_prompt_text(paper), section_content, user_id=user_id)
        exercise = DerivationExercise(
            title=result.get("title", "Derivation Exercise"),
            original_section=result.get("original_section", section_content[:50]),
            starting_point=result.get("starting_point", ""),
            final_result=result.get("final_result", ""),
            steps=result.get("steps", []),
        )
        def _apply(p):
            append_capped(p.cached_analysis, "derivation_exercises", exercise.model_dump())
        mutate_paper(paper_id, user_id, _apply)
        return exercise
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis endpoint 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Exercise generation failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Exercise generation failed. Please try again.")


@router.post("/{paper_id}/qa/suggest")
async def qa_suggest(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Generate fresh suggested questions for a paper.

    The frontend ships a small static list of seed prompts so the Q&A
    tab is never empty on first paint, but those run out fast on a
    real reading session. This endpoint asks the fast model for N
    paper-specific follow-on questions, given a list of `exclude`
    items the user already saw, so the suggestions stay novel as the
    user clicks through them. Counts against the regular `qa`
    budget, atomically reserved like every other LLM call.
    """
    check_feature_access(user_id, "qa")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    raw_excl = body.get("exclude") or []
    exclude: list[str] = [
        s.strip() for s in raw_excl if isinstance(s, str) and s.strip()
    ][:50]

    # Suggestions are cheap relative to a full Q&A so we charge a
    # single unit regardless of how many we generate.
    token = reserve_usage(
        user_id, paper_id, "qa", model=resolve_fast_model(user_id), count=1,
    )
    try:
        from ..services.llm import suggest_questions
        questions = await suggest_questions(
            paper_prompt_text(paper),
            already_seen=exclude,
            user_id=user_id,
        )
        return {"questions": questions}
    except ValueError as exc:
        release_usage(token)
        logger.warning("QA suggest 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Suggestion service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("QA suggest failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Suggestion failed. Please try again.")


@router.post("/{paper_id}/qa", response_model=QAResponse)
async def qa(paper_id: str, req: QARequest, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "qa")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    # A batch of N questions consumes N units against both the daily budget
    # and the per-paper Q&A cap — otherwise users could bypass the cap by
    # clicking "Answer all" with many queued questions.
    if not req.questions:
        raise HTTPException(status_code=400, detail="At least one question is required")
    n_questions = len(req.questions)
    units = n_questions * get_usage_multiplier(user_id)
    token = reserve_usage(
        user_id, paper_id, "qa",
        model=resolve_analysis_model(user_id), count=units,
    )
    try:
        result = await answer_questions(
            paper_prompt_text(paper), req.questions, user_id=user_id, paper_id=paper_id,
        )
        if isinstance(result, dict) and "items" in result:
            resp = QAResponse(**result)
        else:
            resp = QAResponse(items=[QAItem(**item) for item in result])
        payload = resp.model_dump()
        if not append_qa_session_db(paper_id, user_id, payload):
            def _apply(p):
                append_capped(p.cached_analysis, "qa_sessions", payload)
            mutate_paper(paper_id, user_id, _apply)
        else:
            append_cached_analysis_local(paper_id, user_id, "qa_sessions", payload)
        return resp
    except ValueError as exc:
        release_usage(token)
        logger.warning("Q&A 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Q&A service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Q&A failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Q&A failed. Please try again.")


@router.post("/{paper_id}/summary-lite")
async def summary_lite(paper_id: str, body: dict = Body(default={}), user_id: str = Depends(require_auth)):
    """Fast summary preview — runs on Railway to avoid Vercel's 60s Hobby cap."""
    check_feature_access(user_id, "summary")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    requested_model = body.get("model") if isinstance(body, dict) else None
    if isinstance(requested_model, str) and requested_model.strip():
        model_used = enforce_model(
            user_id, canonicalize_model(requested_model.strip()) or requested_model.strip()
        )
    else:
        model_used = resolve_fast_model(user_id)

    token = reserve_usage(
        user_id, paper_id, "summary", model=model_used,
        count=get_usage_multiplier(user_id),
    )
    try:
        result = await summarize_paper_lite(
            paper_prompt_text(paper),
            model_override=model_used,
            user_id=user_id,
        )
        if not result.get("overview"):
            release_usage(token)
            raise HTTPException(
                status_code=502,
                detail="Summary preview returned empty. Please retry.",
            )
        try:
            mutate_paper(
                paper_id,
                user_id,
                lambda p: p.cached_analysis.__setitem__("summary_lite", result),
            )
        except Exception:
            logger.exception("Failed to persist summary_lite for %s", paper_id)
        return result
    except HTTPException:
        release_usage(token)
        raise
    except ValueError as exc:
        release_usage(token)
        logger.warning("summary_lite failed for %s: %s", paper_id, exc)
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception:
        release_usage(token)
        logger.exception("summary_lite failed for %s", paper_id)
        raise HTTPException(status_code=500, detail="Summary preview failed. Please try again.")


@router.post("/{paper_id}/summary")
async def summary(paper_id: str, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "summary")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    token = reserve_usage(
        user_id, paper_id, "api_call", model=resolve_analysis_model(user_id)
    )
    summary_payload = None
    try:
        result = await summarize_paper(paper_prompt_text(paper), user_id=user_id)
        if not result or not result.get("overview"):
            release_usage(token)
            raise HTTPException(status_code=502, detail="Summary generation returned empty results. Please retry.")
        summary_payload = result
        return result
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis endpoint 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Summary generation failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Summary generation failed. Please try again.")
    finally:
        if summary_payload is not None:
            try:
                # Per F-HYDRATION: keep completed summaries durable even if
                # response serialization or a client disconnect follows.
                mutate_paper(
                    paper_id,
                    user_id,
                    lambda p: p.cached_analysis.__setitem__("summary", summary_payload),
                )
            except Exception:
                logger.exception("Failed to persist summary for %s", paper_id)


# /{paper_id}/summary-stream now runs on Next.js + AI SDK at the same
# path on the Vercel deploy
# (frontend/src/app/api/papers/[id]/summary-stream/route.ts). The
# Vercel route uses streamObject(PaperSummary) and streams partial
# JSON the client renders progressively.


@router.post("/{paper_id}/figure-qa")
async def figure_qa(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Analyze a figure using Claude's vision and answer questions about it."""
    import base64
    check_feature_access(user_id, "figures")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    fig_id = body.get("figure_id", "").strip()
    question = body.get("question", "").strip()[:2000]

    if not fig_id:
        raise HTTPException(status_code=400, detail="No figure_id provided")
    _validate_figure_id(fig_id)

    from ..services.pdf_parser import load_figure_png_bytes, load_ocr_image_bytes
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

    # Figure Q&A is a real Q&A call on the paper — count it against the
    # user's per-paper qa quota so figure questions can't bypass the cap.
    token = reserve_usage(
        user_id, paper_id, "qa", model=resolve_fast_model(user_id),
        count=get_usage_multiplier(user_id),
    )
    try:
        result = await analyze_figure(
            paper_prompt_text(paper), image_b64, question, user_id=user_id, paper_id=paper_id,
        )
        result["figure_id"] = fig_id
        result["question"] = question

        def _apply(p):
            append_capped(p.cached_analysis, "figure_analyses", result)
        mutate_paper(paper_id, user_id, _apply)
        return result
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis endpoint 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Figure analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Figure analysis failed. Please try again.")


# /{paper_id}/figure-qa-stream now runs on Next.js + AI SDK at the
# same path on the Vercel deploy
# (frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts). The
# Vercel route fetches the figure PNG via /api/internal/figure/...
# and streams a structured FigureAnalysis JSON.


@router.post("/multi-qa")
async def multi_paper_qa(body: dict, user_id: str = Depends(require_auth)):
    """Answer questions using context from multiple papers in a session.

    Callers sometimes pass the same paper id multiple times (e.g. a stale
    workspace with duplicates). Previously we reserved a per-paper quota row
    per occurrence, double-charging the user for a single logical call; the
    list is deduped here while preserving order so the quota math is honest.
    """
    check_feature_access(user_id, "multi-qa")
    raw_ids = body.get("paper_ids", [])
    if not isinstance(raw_ids, list):
        raw_ids = []

    seen: set[str] = set()
    paper_ids: list[str] = []
    for pid in raw_ids[:50]:
        if not isinstance(pid, str):
            continue
        if pid in seen:
            continue
        seen.add(pid)
        paper_ids.append(pid)
        if len(paper_ids) >= 10:
            break

    questions = body.get("questions", [])[:20]
    questions = [q[:2000] for q in questions if isinstance(q, str)]

    if not paper_ids or not questions:
        raise HTTPException(status_code=400, detail="paper_ids and questions required")

    paper_texts: list[tuple[str, str]] = []
    for pid in paper_ids:
        _validate_id(pid, "paper_id")
        _verify_paper_owner(pid, user_id)
        p = get_paper(pid, user_id=user_id)
        if p:
            paper_texts.append((p.title, paper_prompt_text(p)))

    if not paper_texts:
        raise HTTPException(status_code=404, detail="No valid papers found")

    model = resolve_analysis_model(user_id)
    n_questions = max(1, len(questions))
    units = n_questions * get_usage_multiplier(user_id)

    tokens: list[dict] = []
    try:
        tokens.append(reserve_usage(
            user_id, paper_ids[0], "qa",
            model=model, count=units,
            record_daily=True,
        ))
    except HTTPException:
        for t in tokens:
            release_usage(t)
        raise

    try:
        result = await answer_questions_multi(
            paper_texts, questions, user_id=user_id, paper_ids=paper_ids,
        )
        payload = result if isinstance(result, dict) and "items" in result else {"items": result}
        primary_id = paper_ids[0]

        def _apply_cross(p):
            entry = {
                "questions": questions,
                "items": payload.get("items") or [],
                "paper_ids": paper_ids,
            }
            append_capped(p.cached_analysis, "cross_paper_qa", entry)

        mutate_paper(primary_id, user_id, _apply_cross)

        if isinstance(result, dict) and "items" in result:
            return result
        return {"items": result}
    except ValueError as exc:
        for t in tokens:
            release_usage(t)
        logger.warning("Cross-paper 503: %s", exc)
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except HTTPException:
        for t in tokens:
            release_usage(t)
        raise
    except Exception:
        for t in tokens:
            release_usage(t)
        logger.exception("Multi-paper Q&A failed")
        raise HTTPException(status_code=500, detail="Multi-paper Q&A failed. Please try again.")


_CITED_BY_TTL_SECONDS = 7 * 24 * 3600


@router.get("/{paper_id}/cited_by")
async def get_cited_by(paper_id: str, user_id: str = Depends(require_auth)):
    """Return cached cited_by; refetch if missing or older than 7 days."""
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    cached = paper.cached_analysis.get("cited_by") if paper.cached_analysis else None
    now = int(time.time())
    if isinstance(cached, dict):
        fetched_at = int(cached.get("fetched_at") or 0)
        items = cached.get("items")
        if fetched_at and (now - fetched_at) < _CITED_BY_TTL_SECONDS and isinstance(items, list):
            return {"items": items, "cached": True, "fetched_at": fetched_at}

    from ..services.citation_resolve import (
        resolve_paper_s2_id,
        fetch_cited_by,
        _doi_norm,
        _arxiv_from_blob,
    )

    # Prefer DOI/arXiv that Prepare already extracted into prior_work — those
    # are scoped to the paper's own front-matter, not a citation buried in the
    # references list. Fall back to the very top of raw_text (first ~800 chars)
    # so we still catch the masthead block on papers without cached metadata.
    cached_meta = (paper.cached_analysis or {}).get("paper_metadata") if paper.cached_analysis else None
    doi = ""
    arxiv = ""
    if isinstance(cached_meta, dict):
        doi = (cached_meta.get("doi") or "").strip()
        arxiv = (cached_meta.get("arxiv") or "").strip()
    if not doi and not arxiv:
        head = (paper_prompt_text(paper) or "")[:800]
        doi = _doi_norm(head) or ""
        arxiv = _arxiv_from_blob(head) or ""
    s2_id = await resolve_paper_s2_id(paper.title or "", doi or None, arxiv or None)
    if not s2_id:
        return {"items": [], "cached": False, "error": "s2_not_found"}

    items = await fetch_cited_by(s2_id)
    payload = {"items": items, "fetched_at": now, "s2_id": s2_id}

    def _apply(p):
        p.cached_analysis["cited_by"] = payload

    try:
        mutate_paper(paper_id, user_id, _apply)
    except Exception:
        logger.exception("Failed to persist cited_by for %s", paper_id)

    return {"items": items, "cached": False, "fetched_at": now}
