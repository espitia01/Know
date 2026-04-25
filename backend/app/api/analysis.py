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
from fastapi import APIRouter, HTTPException, Depends, Request
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
    get_fast_provider,
    get_provider,
    _get_figure_prompt,
    _get_selection_prompt,
    _resize_image_b64,
    _normalize_latex_delimiters,
    _safe_parse_json,
    AnthropicProvider,
)
from ..services.pdf_parser import (
    append_capped,
    append_cached_analysis_local,
    get_paper,
    get_figure_path,
    mutate_paper,
)
from ..services.db import append_selection as append_selection_db
from ..services.db import append_qa_session as append_qa_session_db
from ..auth import require_auth
from ..gating import (
    check_feature_access,
    reserve_usage,
    release_usage,
    resolve_analysis_model,
    resolve_fast_model,
)
from ..api.papers import _validate_id, _verify_paper_owner

router = APIRouter(prefix="/api/papers", tags=["analysis"])
logger = logging.getLogger(__name__)


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
    try:
        result = await analyze_paper(paper.raw_text, user_id=user_id)
        analysis = PreReadingAnalysis(
            definitions=result.get("definitions", []),
            research_questions=result.get("research_questions", []),
            prior_work=result.get("prior_work", []),
            concepts=result.get("concepts", []),
        )
        def _apply(p):
            p.cached_analysis["pre_reading"] = analysis.model_dump()
        mutate_paper(paper_id, user_id, _apply)
        return analysis
    except ValueError as exc:
        release_usage(token)
        logger.warning("Analysis 503 for paper %s: %s", paper_id, exc)
        raise HTTPException(status_code=503, detail="Analysis service temporarily unavailable.")
    except HTTPException:
        release_usage(token)
        raise
    except Exception:
        release_usage(token)
        logger.exception("Analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Analysis failed. Please try again.")


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
    # Legacy "question" is folded into Explain; the standalone Ask
    # button was removed (its UX was a near-duplicate of Explain).
    # Anything else unknown also collapses to Explain so old clients
    # don't 4xx.
    if action == "question":
        action = "explain"
    if action not in ("explain", "assumptions", "derive", "followup"):
        action = "explain"
    if action == "assumptions":
        check_feature_access(user_id, "assumptions")
    if not selected_text:
        raise HTTPException(status_code=400, detail="No text selected")

    token = reserve_usage(
        user_id, paper_id, "selection", model=resolve_fast_model(user_id)
    )
    try:
        result = await analyze_selection(paper.raw_text, selected_text, action, user_id=user_id)
        if question:
            # Per audit §11.3: keep selected_text identical to what the
            # server analyzed, and persist the user's short follow-up prompt
            # separately so hydration does not rewrite threaded entries.
            result["question"] = question
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

    def _apply(p):
        items = p.cached_analysis.get("selections") or []
        p.cached_analysis["selections"] = [
            s for s in items
            if not (
                isinstance(s, dict)
                and (s.get("selected_text") or "").strip() == selected_text
                and (s.get("action") or "explain") == action
            )
        ]

    try:
        mutate_paper(paper_id, user_id, _apply)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Paper not found")
    return {"ok": True}


@router.post("/{paper_id}/selection-stream")
async def selection_analysis_stream(
    paper_id: str, body: dict, request: Request,
    user_id: str = Depends(require_auth),
):
    """Stream selection analysis token-by-token via SSE.

    Cancels the upstream Anthropic call when the client disconnects so we
    don't keep paying for tokens the user will never see. Emits a terminal
    ``done`` event even on failure so the frontend state machine can't get
    stuck in "loading" on a dropped stream.
    """
    import json as _json

    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    selected_text = body.get("selected_text", "").strip()[:10000]
    question = (body.get("question") or "").strip()[:2000]
    action = body.get("action", "explain")
    if action == "question":
        action = "explain"
    if action not in ("explain", "assumptions", "derive", "followup"):
        action = "explain"
    if action == "assumptions":
        check_feature_access(user_id, "assumptions")
    if not selected_text:
        raise HTTPException(status_code=400, detail="No text selected")

    provider = get_fast_provider(user_id)
    if not isinstance(provider, AnthropicProvider):
        raise HTTPException(status_code=503, detail="Streaming requires Anthropic provider")

    token = reserve_usage(user_id, paper_id, "selection", model=provider.model)

    system, user_text = _get_selection_prompt(paper.raw_text, selected_text, action)

    async def event_stream():
        full_text = ""
        completed = False
        disconnected = False
        try:
            async for chunk in provider.stream_complete(system, user_text, max_tokens=4096):
                if await request.is_disconnected():
                    # Abort upstream Anthropic call by exiting the async-for.
                    # The httpx.AsyncClient.stream() context manager cancels
                    # the underlying HTTP request when its generator is
                    # closed, which releases the API-side token budget too.
                    disconnected = True
                    break
                full_text += chunk
                normalized = _normalize_latex_delimiters(chunk)
                yield f"data: {_json.dumps({'type': 'chunk', 'text': normalized})}\n\n"

            if disconnected:
                return

            full_text = _normalize_latex_delimiters(full_text)
            yield f"data: {_json.dumps({'type': 'done', 'full_text': full_text})}\n\n"

            result = {
                "action": action,
                "selected_text": selected_text,
                "explanation": full_text,
            }
            if question:
                result["question"] = question

            try:
                if append_selection_db(paper_id, user_id, result):
                    append_cached_analysis_local(paper_id, user_id, "selections", result)
                else:
                    def _apply(p):
                        append_capped(p.cached_analysis, "selections", result)
                    mutate_paper(paper_id, user_id, _apply)
            except Exception:
                logger.exception("Failed to persist selection stream for %s", paper_id)
            completed = True
        except asyncio.CancelledError:
            disconnected = True
            raise
        except Exception:
            logger.exception("Selection stream error for paper %s", paper_id)
            yield f"data: {_json.dumps({'type': 'error', 'message': 'Analysis failed. Please try again.'})}\n\n"
            # Always follow `error` with a terminal `done` so the client's
            # state machine can't get stuck waiting for the next event.
            yield f"data: {_json.dumps({'type': 'done', 'full_text': ''})}\n\n"
        finally:
            if not completed:
                release_usage(token)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{paper_id}/explain", response_model=ExplainResponse)
async def explain(paper_id: str, req: ExplainRequest, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    token = reserve_usage(
        user_id, paper_id, "selection", model=resolve_analysis_model(user_id)
    )
    try:
        result = await explain_term(paper.raw_text, req.term, req.context, user_id=user_id)
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
        user_id, paper_id, "selection", model=resolve_analysis_model(user_id)
    )
    try:
        result = await find_skipped_steps(paper.raw_text, section_content, user_id=user_id)
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
    try:
        result = await extract_assumptions(paper.raw_text, user_id=user_id)
        # If the LLM output was malformed and we fell through to the
        # safe-parse fallback (`{}`), do NOT cache an empty assumptions
        # list. Caching it creates the "disappearing assumptions" bug:
        # the UI reads `{assumptions: []}` from the server, renders the
        # "Extract Assumptions" empty state, and the user's re-extract
        # clicks keep hitting the same failure mode. Surfacing an error
        # here gives the panel a concrete "retry" target instead of a
        # silent loop.
        raw_items = result.get("assumptions") if isinstance(result, dict) else None
        if not isinstance(raw_items, list) or len(raw_items) == 0:
            release_usage(token)
            logger.warning(
                "Assumptions extraction returned no items for paper %s (raw=%s)",
                paper_id, type(result).__name__,
            )
            raise HTTPException(
                status_code=502,
                detail="The analysis model didn't return usable assumptions. Please try again.",
            )
        resp = AssumptionsResponse(assumptions=raw_items)
        def _apply(p):
            p.cached_analysis["assumptions"] = resp.model_dump()
        mutate_paper(paper_id, user_id, _apply)
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
        user_id, paper_id, "selection", model=resolve_analysis_model(user_id)
    )
    try:
        result = await generate_derivation_exercise(paper.raw_text, section_content, user_id=user_id)
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
            paper.raw_text,
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
    n_questions = max(1, len(req.questions))
    token = reserve_usage(
        user_id, paper_id, "qa",
        model=resolve_analysis_model(user_id), count=n_questions,
    )
    try:
        result = await answer_questions(paper.raw_text, req.questions, user_id=user_id)
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
    try:
        result = await summarize_paper(paper.raw_text, user_id=user_id)
        if not result or not result.get("overview"):
            release_usage(token)
            raise HTTPException(status_code=502, detail="Summary generation returned empty results. Please retry.")
        def _apply(p):
            p.cached_analysis["summary"] = result
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
        logger.exception("Summary generation failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Summary generation failed. Please try again.")


@router.post("/{paper_id}/summary-stream")
async def summary_stream(
    paper_id: str, request: Request, user_id: str = Depends(require_auth),
):
    """Stream summary generation token-by-token, then send the parsed JSON at
    the end. Cancels the upstream call on client disconnect (C4) and emits a
    terminal ``done`` after any error (M3)."""
    import json as _json

    check_feature_access(user_id, "summary")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    provider = get_provider(user_id)
    if not isinstance(provider, AnthropicProvider):
        raise HTTPException(status_code=503, detail="Streaming requires Anthropic provider")

    token = reserve_usage(user_id, paper_id, "api_call", model=provider.model)

    system = """You are an expert science educator and researcher. Produce an extremely detailed, structured summary of the academic paper. Return ONLY valid JSON. CRITICAL: For ALL math expressions, use $ delimiters for inline math and $$ for display math. NEVER use \\( \\) or \\[ \\] delimiters."""

    user_text = f"""Create an extremely detailed summary of this academic paper. The summary should be comprehensive enough that someone could understand the paper's full contribution without reading the original.

Structure your summary with ALL of the following sections:

1. **overview**: A 3-5 sentence high-level overview of what the paper does and why it matters.
2. **motivation**: Why was this work done? What gap in knowledge does it fill? (3-5 sentences)
3. **key_contributions**: Array of the paper's main contributions (each as a string, 1-2 sentences).
4. **methodology**: Detailed explanation of the methods, models, or theoretical framework used. Include equations where relevant. (Multiple paragraphs)
5. **main_results**: Detailed description of the key findings, including quantitative results. Use LaTeX for any numbers or equations. (Multiple paragraphs)
6. **discussion**: What do the results mean? How do they compare to prior work? What are the implications? (Multiple paragraphs)
7. **limitations**: Array of limitations or caveats the authors mention or that are apparent.
8. **future_work**: What follow-up research does this enable or suggest? (2-3 sentences)
9. **key_equations**: Array of the most important equations in the paper, each as {{"equation": "LaTeX", "meaning": "what it represents"}}.
10. **key_figures_and_tables**: Array of descriptions of the most important figures/tables: {{"id": "Fig. 1", "description": "what it shows and why it matters"}}.

Paper content:
{paper.raw_text[:12000]}

Return JSON with all the above fields."""

    async def event_stream():
        full_text = ""
        completed = False
        disconnected = False
        try:
            async for chunk in provider.stream_complete(system, user_text, max_tokens=6000):
                if await request.is_disconnected():
                    disconnected = True
                    break
                full_text += chunk
                normalized = _normalize_latex_delimiters(chunk)
                yield f"data: {_json.dumps({'type': 'chunk', 'text': normalized})}\n\n"

            if disconnected:
                return

            full_text_normalized = _normalize_latex_delimiters(full_text)
            parsed = _safe_parse_json(full_text)
            if parsed and parsed.get("overview"):
                def _apply(p):
                    p.cached_analysis["summary"] = parsed
                try:
                    mutate_paper(paper_id, user_id, _apply)
                except Exception:
                    logger.exception("Failed to persist summary for %s", paper_id)
                completed = True
                yield f"data: {_json.dumps({'type': 'done', 'summary': parsed, 'full_text': full_text_normalized})}\n\n"
            else:
                yield f"data: {_json.dumps({'type': 'done', 'full_text': full_text_normalized})}\n\n"
        except asyncio.CancelledError:
            disconnected = True
            raise
        except Exception:
            logger.exception("Summary stream error for paper %s", paper_id)
            yield f"data: {_json.dumps({'type': 'error', 'message': 'Summary generation failed. Please try again.'})}\n\n"
            yield f"data: {_json.dumps({'type': 'done', 'full_text': ''})}\n\n"
        finally:
            if not completed:
                release_usage(token)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
    _validate_id(fig_id, "fig_id")

    fig_path = get_figure_path(paper_id, fig_id)
    if not fig_path:
        raise HTTPException(status_code=404, detail="Figure not found")

    image_b64 = base64.b64encode(fig_path.read_bytes()).decode("utf-8")

    # Figure Q&A is a real Q&A call on the paper — count it against the
    # user's per-paper qa quota so figure questions can't bypass the cap.
    token = reserve_usage(
        user_id, paper_id, "qa", model=resolve_fast_model(user_id)
    )
    try:
        result = await analyze_figure(paper.raw_text, image_b64, question, user_id=user_id)
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


@router.post("/{paper_id}/figure-qa-stream")
async def figure_qa_stream(
    paper_id: str, body: dict, request: Request,
    user_id: str = Depends(require_auth),
):
    """Stream figure analysis token-by-token via SSE. Cancels upstream on
    client disconnect (C4) and emits terminal ``done`` after errors (M3)."""
    import base64
    import json as _json
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
    _validate_id(fig_id, "fig_id")

    fig_path = get_figure_path(paper_id, fig_id)
    if not fig_path:
        raise HTTPException(status_code=404, detail="Figure not found")

    image_b64 = _resize_image_b64(
        base64.b64encode(fig_path.read_bytes()).decode("utf-8")
    )

    provider = get_fast_provider(user_id)
    if not isinstance(provider, AnthropicProvider):
        raise HTTPException(status_code=503, detail="Streaming requires Anthropic provider")

    token = reserve_usage(user_id, paper_id, "qa", model=provider.model)

    system, user_text = _get_figure_prompt(paper.raw_text, question)

    async def event_stream():
        full_text = ""
        completed = False
        disconnected = False
        try:
            async for chunk in provider.stream_complete_with_image(
                system, user_text, image_b64, max_tokens=2048
            ):
                if await request.is_disconnected():
                    disconnected = True
                    break
                full_text += chunk
                normalized = _normalize_latex_delimiters(chunk)
                yield f"data: {_json.dumps({'type': 'chunk', 'text': normalized})}\n\n"

            if disconnected:
                return

            full_text = _normalize_latex_delimiters(full_text)
            yield f"data: {_json.dumps({'type': 'done', 'full_text': full_text})}\n\n"

            result = {
                "figure_id": fig_id,
                "question": question,
                "description": full_text,
                "key_observations": [],
                "relation_to_paper": "",
            }
            def _apply(p):
                append_capped(p.cached_analysis, "figure_analyses", result)
            try:
                mutate_paper(paper_id, user_id, _apply)
            except Exception:
                logger.exception("Failed to persist figure stream for %s", paper_id)
            completed = True
        except asyncio.CancelledError:
            disconnected = True
            raise
        except Exception:
            logger.exception("Figure stream error for paper %s", paper_id)
            yield f"data: {_json.dumps({'type': 'error', 'message': 'Figure analysis failed. Please try again.'})}\n\n"
            yield f"data: {_json.dumps({'type': 'done', 'full_text': ''})}\n\n"
        finally:
            if not completed:
                release_usage(token)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
            paper_texts.append((p.title, p.raw_text))

    if not paper_texts:
        raise HTTPException(status_code=404, detail="No valid papers found")

    model = resolve_analysis_model(user_id)
    n_questions = max(1, len(questions))

    tokens: list[dict] = []
    try:
        for idx, pid in enumerate(paper_ids):
            tokens.append(reserve_usage(
                user_id, pid, "qa",
                model=model, count=n_questions,
                record_daily=(idx == 0),
            ))
    except HTTPException:
        for t in tokens:
            release_usage(t)
        raise

    try:
        result = await answer_questions_multi(paper_texts, questions, user_id=user_id)
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
