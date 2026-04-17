"""API routes for AI-powered paper analysis."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

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
    answer_questions,
    explain_term,
    extract_assumptions,
    find_skipped_steps,
    generate_derivation_exercise,
)
from ..services.pdf_parser import get_paper, save_paper

router = APIRouter(prefix="/api/papers", tags=["analysis"])


@router.post("/{paper_id}/analyze", response_model=PreReadingAnalysis)
async def analyze(paper_id: str):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        result = await analyze_paper(paper.content_markdown)
        analysis = PreReadingAnalysis(
            definitions=result.get("definitions", []),
            research_questions=result.get("research_questions", []),
            prior_work=result.get("prior_work", []),
            concepts=result.get("concepts", []),
        )
        paper.cached_analysis["pre_reading"] = analysis.model_dump()
        save_paper(paper)
        return analysis
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")


@router.post("/{paper_id}/explain", response_model=ExplainResponse)
async def explain(paper_id: str, req: ExplainRequest):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        result = await explain_term(paper.content_markdown, req.term, req.context)
        resp = ExplainResponse(
            term=result.get("term", req.term),
            explanation=result.get("explanation", "Could not generate explanation."),
            source=result.get("source", ""),
            in_paper=result.get("in_paper", False),
        )
        explains = paper.cached_analysis.get("explains", [])
        explains.append(resp.model_dump())
        paper.cached_analysis["explains"] = explains
        save_paper(paper)
        return resp
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Explain failed: {e}")


@router.post("/{paper_id}/skipped-steps")
async def skipped_steps(paper_id: str, body: dict):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    section_content = body.get("section", "")

    try:
        result = await find_skipped_steps(paper.content_markdown, section_content)
        skipped = paper.cached_analysis.get("skipped_steps", [])
        skipped.append(result)
        paper.cached_analysis["skipped_steps"] = skipped
        save_paper(paper)
        return result
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Skipped steps failed: {e}")


@router.post("/{paper_id}/assumptions", response_model=AssumptionsResponse)
async def assumptions(paper_id: str):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        result = await extract_assumptions(paper.content_markdown)
        resp = AssumptionsResponse(assumptions=result.get("assumptions", []))
        paper.cached_analysis["assumptions"] = resp.model_dump()
        save_paper(paper)
        return resp
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Assumptions extraction failed: {e}")


@router.post("/{paper_id}/derivation/exercise", response_model=DerivationExercise)
async def derivation_exercise(paper_id: str, body: dict):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    section_content = body.get("section", "")

    try:
        result = await generate_derivation_exercise(paper.content_markdown, section_content)
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
        save_paper(paper)
        return exercise
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Exercise generation failed: {e}")


@router.post("/{paper_id}/qa", response_model=QAResponse)
async def qa(paper_id: str, req: QARequest):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    try:
        result = await answer_questions(paper.content_markdown, req.questions)
        if isinstance(result, dict) and "items" in result:
            resp = QAResponse(**result)
        else:
            resp = QAResponse(items=[QAItem(**item) for item in result])
        qa_sessions = paper.cached_analysis.get("qa_sessions", [])
        qa_sessions.append(resp.model_dump())
        paper.cached_analysis["qa_sessions"] = qa_sessions
        save_paper(paper)
        return resp
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Q&A failed: {e}")
