"""API routes for AI-powered paper analysis."""

from __future__ import annotations

import logging
from fastapi import APIRouter, HTTPException, Depends
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
    _get_figure_prompt,
    _get_selection_prompt,
    _resize_image_b64,
    _normalize_latex_delimiters,
    AnthropicProvider,
)
from ..services.pdf_parser import get_paper, get_figure_path, save_paper
from ..auth import require_auth
from ..gating import check_feature_access, check_usage_limit, track_usage
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

    try:
        result = await analyze_paper(paper.raw_text, user_id=user_id)
        analysis = PreReadingAnalysis(
            definitions=result.get("definitions", []),
            research_questions=result.get("research_questions", []),
            prior_work=result.get("prior_work", []),
            concepts=result.get("concepts", []),
        )
        paper.cached_analysis["pre_reading"] = analysis.model_dump()
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "api_call")
        return analysis
    except ValueError:
        raise HTTPException(status_code=503, detail="Analysis service temporarily unavailable.")
    except Exception as e:
        logger.exception("Analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Analysis failed. Please try again.")


@router.post("/{paper_id}/selection")
async def selection_analysis(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Analyze user-highlighted text from the PDF viewer."""
    check_feature_access(user_id, "selection")
    check_usage_limit(user_id, paper_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    selected_text = body.get("selected_text", "").strip()[:10000]
    action = body.get("action", "explain")
    if action not in ("explain", "assumptions", "derive", "question"):
        action = "explain"
    if action == "assumptions":
        check_feature_access(user_id, "assumptions")
    if not selected_text:
        raise HTTPException(status_code=400, detail="No text selected")

    try:
        result = await analyze_selection(paper.raw_text, selected_text, action, user_id=user_id)
        selections = paper.cached_analysis.get("selections", [])
        selections.append(result)
        paper.cached_analysis["selections"] = selections
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "selection")
        return result
    except ValueError:
        raise HTTPException(status_code=503, detail="Selection analysis service temporarily unavailable.")
    except Exception as e:
        logger.exception("Selection analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Selection analysis failed. Please try again.")


@router.post("/{paper_id}/selection-stream")
async def selection_analysis_stream(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Stream selection analysis token-by-token via SSE."""
    import json as _json

    check_feature_access(user_id, "selection")
    check_usage_limit(user_id, paper_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)

    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    selected_text = body.get("selected_text", "").strip()[:10000]
    action = body.get("action", "explain")
    if action not in ("explain", "assumptions", "derive", "question"):
        action = "explain"
    if action == "assumptions":
        check_feature_access(user_id, "assumptions")
    if not selected_text:
        raise HTTPException(status_code=400, detail="No text selected")

    provider = get_fast_provider(user_id)
    if not isinstance(provider, AnthropicProvider):
        raise HTTPException(status_code=503, detail="Streaming requires Anthropic provider")

    system, user_text = _get_selection_prompt(paper.raw_text, selected_text, action)

    async def event_stream():
        full_text = ""
        try:
            async for chunk in provider.stream_complete(system, user_text, max_tokens=4096):
                full_text += chunk
                normalized = _normalize_latex_delimiters(chunk)
                yield f"data: {_json.dumps({'type': 'chunk', 'text': normalized})}\n\n"

            full_text = _normalize_latex_delimiters(full_text)
            yield f"data: {_json.dumps({'type': 'done', 'full_text': full_text})}\n\n"

            result = {
                "action": action,
                "selected_text": selected_text,
                "explanation": full_text,
            }
            selections = paper.cached_analysis.get("selections", [])
            selections.append(result)
            paper.cached_analysis["selections"] = selections
            save_paper(paper, user_id=user_id)
            track_usage(user_id, paper_id, "selection")
        except Exception as e:
            logger.exception("Selection stream error for paper %s", paper_id)
            yield f"data: {_json.dumps({'type': 'error', 'message': 'Analysis failed. Please try again.'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{paper_id}/explain", response_model=ExplainResponse)
async def explain(paper_id: str, req: ExplainRequest, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    check_usage_limit(user_id, paper_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        result = await explain_term(paper.raw_text, req.term, req.context, user_id=user_id)
        resp = ExplainResponse(
            term=result.get("term", req.term),
            explanation=result.get("explanation", "Could not generate explanation."),
            source=result.get("source", ""),
            in_paper=result.get("in_paper", False),
        )
        explains = paper.cached_analysis.get("explains", [])
        explains.append(resp.model_dump())
        paper.cached_analysis["explains"] = explains
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "selection")
        return resp
    except Exception as e:
        logger.exception("Explain failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Explain failed. Please try again.")


@router.post("/{paper_id}/skipped-steps")
async def skipped_steps(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    check_usage_limit(user_id, paper_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    section_content = body.get("section", "")[:10000]

    try:
        result = await find_skipped_steps(paper.raw_text, section_content, user_id=user_id)
        skipped = paper.cached_analysis.get("skipped_steps", [])
        skipped.append(result)
        paper.cached_analysis["skipped_steps"] = skipped
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "selection")
        return result
    except ValueError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except Exception as e:
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

    try:
        result = await extract_assumptions(paper.raw_text, user_id=user_id)
        resp = AssumptionsResponse(assumptions=result.get("assumptions", []))
        paper.cached_analysis["assumptions"] = resp.model_dump()
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "api_call")
        return resp
    except ValueError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except Exception as e:
        logger.exception("Assumptions extraction failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Assumptions extraction failed. Please try again.")


@router.post("/{paper_id}/derivation/exercise", response_model=DerivationExercise)
async def derivation_exercise(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "selection")
    check_usage_limit(user_id, paper_id, "selection")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    section_content = body.get("section", "")[:10000]

    try:
        result = await generate_derivation_exercise(paper.raw_text, section_content, user_id=user_id)
        exercise = DerivationExercise(
            title=result.get("title", "Derivation Exercise"),
            original_section=result.get("original_section", section_content[:50]),
            starting_point=result.get("starting_point", ""),
            final_result=result.get("final_result", ""),
            steps=result.get("steps", []),
        )
        exercises = paper.cached_analysis.get("derivation_exercises", [])
        exercises.append(exercise.model_dump())
        paper.cached_analysis["derivation_exercises"] = exercises
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "selection")
        return exercise
    except ValueError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except Exception as e:
        logger.exception("Exercise generation failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Exercise generation failed. Please try again.")


@router.post("/{paper_id}/qa", response_model=QAResponse)
async def qa(paper_id: str, req: QARequest, user_id: str = Depends(require_auth)):
    check_feature_access(user_id, "qa")
    check_usage_limit(user_id, paper_id, "qa")
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        result = await answer_questions(paper.raw_text, req.questions, user_id=user_id)
        if isinstance(result, dict) and "items" in result:
            resp = QAResponse(**result)
        else:
            resp = QAResponse(items=[QAItem(**item) for item in result])
        qa_sessions = paper.cached_analysis.get("qa_sessions", [])
        qa_sessions.append(resp.model_dump())
        paper.cached_analysis["qa_sessions"] = qa_sessions
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "qa")
        return resp
    except ValueError:
        raise HTTPException(status_code=503, detail="Q&A service temporarily unavailable.")
    except Exception as e:
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

    try:
        result = await summarize_paper(paper.raw_text, user_id=user_id)
        paper.cached_analysis["summary"] = result
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "api_call")
        return result
    except ValueError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except Exception as e:
        logger.exception("Summary generation failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Summary generation failed. Please try again.")


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

    try:
        result = await analyze_figure(paper.raw_text, image_b64, question, user_id=user_id)
        result["figure_id"] = fig_id
        result["question"] = question

        figure_analyses = paper.cached_analysis.get("figure_analyses", [])
        figure_analyses.append(result)
        paper.cached_analysis["figure_analyses"] = figure_analyses
        save_paper(paper, user_id=user_id)
        track_usage(user_id, paper_id, "api_call")
        return result
    except ValueError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except Exception as e:
        logger.exception("Figure analysis failed for paper %s", paper_id)
        raise HTTPException(status_code=500, detail="Figure analysis failed. Please try again.")


@router.post("/{paper_id}/figure-qa-stream")
async def figure_qa_stream(paper_id: str, body: dict, user_id: str = Depends(require_auth)):
    """Stream figure analysis token-by-token via SSE."""
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

    system, user_text = _get_figure_prompt(paper.raw_text, question)

    async def event_stream():
        full_text = ""
        try:
            async for chunk in provider.stream_complete_with_image(
                system, user_text, image_b64, max_tokens=2048
            ):
                full_text += chunk
                normalized = _normalize_latex_delimiters(chunk)
                yield f"data: {_json.dumps({'type': 'chunk', 'text': normalized})}\n\n"

            full_text = _normalize_latex_delimiters(full_text)
            yield f"data: {_json.dumps({'type': 'done', 'full_text': full_text})}\n\n"

            result = {
                "figure_id": fig_id,
                "question": question,
                "description": full_text,
                "key_observations": [],
                "relation_to_paper": "",
            }
            figure_analyses = paper.cached_analysis.get("figure_analyses", [])
            figure_analyses.append(result)
            paper.cached_analysis["figure_analyses"] = figure_analyses
            save_paper(paper, user_id=user_id)
            track_usage(user_id, paper_id, "api_call")
        except Exception as e:
            logger.exception("Figure stream error for paper %s", paper_id)
            yield f"data: {_json.dumps({'type': 'error', 'message': 'Figure analysis failed. Please try again.'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/multi-qa")
async def multi_paper_qa(body: dict, user_id: str = Depends(require_auth)):
    """Answer questions using context from multiple papers in a session."""
    check_feature_access(user_id, "multi-qa")
    paper_ids = body.get("paper_ids", [])[:10]
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

    try:
        result = await answer_questions_multi(paper_texts, questions, user_id=user_id)
        for pid in paper_ids:
            track_usage(user_id, pid, "qa")
        if isinstance(result, dict) and "items" in result:
            return result
        return {"items": result}
    except ValueError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable.")
    except Exception as e:
        logger.exception("Multi-paper Q&A failed")
        raise HTTPException(status_code=500, detail="Multi-paper Q&A failed. Please try again.")
