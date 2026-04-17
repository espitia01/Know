from __future__ import annotations

from pydantic import BaseModel


class FigureInfo(BaseModel):
    id: str
    url: str
    caption: str
    page: int = 0


class Reference(BaseModel):
    id: str
    text: str


class ParsedPaper(BaseModel):
    id: str
    title: str
    authors: list[str]
    affiliations: list[str] = []
    abstract: str
    content_markdown: str
    figures: list[FigureInfo] = []
    references: list[Reference] = []
    has_si: bool = False
    folder: str = ""
    tags: list[str] = []
    notes: list[dict] = []
    cached_analysis: dict = {}


class Definition(BaseModel):
    term: str
    definition: str
    source: str = ""


class ResearchQuestion(BaseModel):
    question: str
    context: str = ""


class PriorWork(BaseModel):
    title: str
    relevance: str
    ref_id: str = ""


class Concept(BaseModel):
    name: str
    description: str
    importance: str = ""


class PreReadingAnalysis(BaseModel):
    definitions: list[Definition] = []
    research_questions: list[ResearchQuestion] = []
    prior_work: list[PriorWork] = []
    concepts: list[Concept] = []


class Assumption(BaseModel):
    statement: str
    type: str  # "explicit" or "implicit"
    section: str = ""


class DerivationStep(BaseModel):
    step_number: int
    prompt: str = ""
    answer: str = ""
    expression: str = ""
    explanation: str = ""
    hint: str = ""


class DerivationExercise(BaseModel):
    title: str
    original_section: str
    starting_point: str = ""
    final_result: str = ""
    steps: list[DerivationStep]


class QAItem(BaseModel):
    question: str
    answer: str = ""


class QARequest(BaseModel):
    questions: list[str]


class QAResponse(BaseModel):
    items: list[QAItem]


class ExplainRequest(BaseModel):
    term: str
    context: str = ""


class ExplainResponse(BaseModel):
    term: str
    explanation: str
    source: str = ""
    in_paper: bool = False


class SkippedStepsResponse(BaseModel):
    section: str
    original_derivation: str
    filled_steps: list[DerivationStep]


class AssumptionsResponse(BaseModel):
    assumptions: list[Assumption]


class SearchResult(BaseModel):
    section: str
    snippet: str
    match_type: str  # "content", "definition", "qa"


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]


class SettingsUpdate(BaseModel):
    anthropic_api_key: str | None = None
    local_model_url: str | None = None
    local_model_name: str | None = None
    active_provider: str | None = None


class SettingsResponse(BaseModel):
    has_anthropic_key: bool
    local_model_url: str
    local_model_name: str
    active_provider: str
