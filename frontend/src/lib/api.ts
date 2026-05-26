import { invalidatePaper } from "@/lib/papersFreshness";

let _getToken: (() => Promise<string | null>) | null = null;
let _cachedToken: string | null = null;
let _tokenRefreshInterval: ReturnType<typeof setInterval> | null = null;
// Dedupe concurrent refreshes: if a refresh is already in flight, subsequent
// callers await the same promise instead of kicking off parallel requests
// whose resolution order can clobber `_cachedToken` out-of-order.
let _inflightRefresh: Promise<string | null> | null = null;

function refreshToken(): Promise<string | null> {
  if (!_getToken) return Promise.resolve(null);
  if (_inflightRefresh) return _inflightRefresh;
  const fn = _getToken;
  _inflightRefresh = fn()
    .then((t) => {
      _cachedToken = t;
      return t;
    })
    .finally(() => {
      _inflightRefresh = null;
    });
  return _inflightRefresh;
}

export function setClerkTokenGetter(fn: () => Promise<string | null>) {
  _getToken = fn;
  clearTokenRefreshInterval();
  void refreshToken();
  _tokenRefreshInterval = setInterval(() => {
    void refreshToken();
  }, 50 * 60 * 1000);
}

export function clearTokenRefreshInterval() {
  if (_tokenRefreshInterval) {
    clearInterval(_tokenRefreshInterval);
    _tokenRefreshInterval = null;
  }
}

// Drop every scrap of the previous user's auth state. Called on sign-out so
// a subsequent sign-in in the same tab can't reuse the old bearer.
export function clearAuthState() {
  clearTokenRefreshInterval();
  _getToken = null;
  _cachedToken = null;
  _inflightRefresh = null;
}

export function getAuthHeadersSync(): Record<string, string> {
  if (_getToken && _cachedToken) {
    void refreshToken();
  }
  return _cachedToken ? { Authorization: `Bearer ${_cachedToken}` } : {};
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export { API_BASE };

async function authHeaders(): Promise<Record<string, string>> {
  if (_getToken) {
    const token = await refreshToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {};
}

// Legacy string match kept for backward compatibility with any backend that
// hasn't shipped the structured-detail change yet. New code paths branch on
// `detail.code` — see `StructuredErrorDetail` below.
const MODEL_CAP_DETAIL_RE =
  /Daily limit reached for (\S+) \((\d+)\/day on (\S+) plan\)/;

type StructuredErrorDetail = {
  code?:
    | "daily_cap"
    | "model_cap"
    | "paper_cap"
    | "daily_export_cap"
    | "export_tier"
    | "export_concurrent"
    | "prepare_empty";
  model?: string;
  limit?: number;
  tier?: string;
  action?: string;
  message?: string;
};

function parseDetail(
  raw: unknown
): { message: string; structured: StructuredErrorDetail | null } {
  if (raw && typeof raw === "object") {
    const obj = raw as StructuredErrorDetail;
    return { message: obj.message || "Request failed", structured: obj };
  }
  if (typeof raw === "string") return { message: raw, structured: null };
  return { message: "Request failed", structured: null };
}

async function request<T>(
  path: string,
  options?: RequestInit,
  retryCount = 0
): Promise<T> {
  const headers = await authHeaders();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...headers,
        ...options?.headers,
      },
    });
    if (res.status === 401 && retryCount === 0 && _getToken) {
      // Per audit §8.2: Clerk tokens are long-lived; refresh on the
      // rare 401 and retry once instead of polling every 45 seconds.
      await refreshToken();
      return request<T>(path, options, retryCount + 1);
    }
    if (res.status === 401) {
      if (typeof window !== "undefined") {
        window.location.href = "/sign-in";
      }
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const status = res.status;
      let message: string = `Request failed (${status})`;
      let structured: StructuredErrorDetail | null = null;
      try {
        const body = await res.json();
        const parsed = parseDetail(body?.detail);
        message = parsed.message;
        structured = parsed.structured;
        if (
          message === "Method Not Allowed" ||
          (typeof body?.detail === "string" && body.detail === "Method Not Allowed")
        ) {
          message =
            "This API route only accepts POST. If you see this while using Q&A, ignore any GET /qa lines in server logs — the app calls POST; GET 405s are usually manual probes.";
        }
        if (status === 503 && typeof body?.detail === "string" && body.detail.trim()) {
          message = body.detail.trim();
        }
        if (structured?.code === "prepare_empty") {
          message = structured.message || message;
        }
      } catch {
        // Non-JSON response; fall through with default message.
      }

      // Per-model cap: prompt the user to switch and retry once. Accept
      // both the structured `{code: "model_cap", model, limit, tier}` form
      // and the legacy free-text detail so older backends keep working.
      if (status === 429 && retryCount === 0) {
        let cappedModel: string | null = null;
        let limit = 0;
        let tier = "";

        if (structured?.code === "model_cap" && structured.model) {
          cappedModel = structured.model;
          limit = structured.limit || 0;
          tier = structured.tier || "";
        } else {
          const match = message.match(MODEL_CAP_DETAIL_RE);
          if (match) {
            cappedModel = match[1];
            limit = parseInt(match[2], 10) || 0;
            tier = match[3];
          }
        }

        if (cappedModel) {
          const { promptModelCap } = await import("./modelCapPrompt");
          const result = await promptModelCap({ cappedModel, limit, tier });
          if (result && result.fallback) {
            try {
              // Only rewrite the slot(s) that point at the capped model so we
              // don't silently change the other preference.
              const current = await request<SettingsResponse>("/api/settings");
              const update: Record<string, string> = {};
              if (current.analysis_model === cappedModel)
                update.analysis_model = result.fallback;
              if (current.fast_model === cappedModel)
                update.fast_model = result.fallback;
              if (!update.analysis_model && !update.fast_model) {
                // Capped model wasn't either pref (edge case, e.g. prefs
                // changed mid-flight). Point both at the fallback so the
                // retry actually uses something different.
                update.analysis_model = result.fallback;
                update.fast_model = result.fallback;
              }
              await request<SettingsResponse>("/api/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(update),
              });
            } catch {
              throw new Error(message);
            }
            return request<T>(path, options, retryCount + 1);
          }
        }
      }

      throw new Error(message);
    }
    const text = await res.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text);
    } catch {
      return {} as T;
    }
  } finally {
    clearTimeout(timeout);
  }
}

const _inflightGetRequests = new Map<string, Promise<unknown>>();

function getRequest<T>(path: string): Promise<T> {
  const existing = _inflightGetRequests.get(path) as Promise<T> | undefined;
  if (existing) return existing;
  // Per audit §8.3: rapid paper/session switches can request the same GET
  // multiple times before the first response lands. Share one promise for
  // idempotent reads and drop it as soon as it settles.
  const p = request<T>(path).finally(() => {
    _inflightGetRequests.delete(path);
  });
  _inflightGetRequests.set(path, p);
  return p;
}

export interface FigureInfo {
  id: string;
  url: string;
  caption: string;
  page: number;
}

export interface OcrImage {
  id: string;
  page: number;
  bbox?: number[] | null;
  caption?: string;
  kind?: "figure" | "panel";
  panel_ids?: string[] | null;
}

export interface Note {
  id: string;
  text: string;
  section: string;
  created_at: number;
}

/** Bibliography line as extracted for the paper reader (numbered references). */
export interface PaperReference {
  id: string;
  text: string;
}

export interface ParsedPaper {
  id: string;
  title: string;
  authors: string[];
  raw_text: string;
  /** Mistral OCR markdown — omitted from list/get payloads; load via getPaperMarkdown or markdownByPaper. */
  markdown?: string;
  ocr_status?: string;
  ocr_model?: string;
  ocr_images?: OcrImage[];
  figures: FigureInfo[];
  has_si: boolean;
  folder: string;
  tags: string[];
  notes: Note[];
  cached_analysis: {
    pre_reading?: PreReadingAnalysis;
    assumptions?: { assumptions: Assumption[] };
    derivation_exercises?: DerivationExercise[];
    qa_sessions?: { items: QAItem[] }[];
    explains?: ExplainResponse[];
    selections?: SelectionAnalysisResult[];
    /** Coalesced summary (legacy single-blob path, still rendered). */
    summary?: PaperSummary;
    /** PROMPT_7: fast first-impression summary (overview + tl_dr + key contributions). */
    summary_lite?: PaperSummary;
    /** PROMPT_7: detailed body (methodology, results, discussion, limitations, future work, figures). */
    summary_deep?: PaperSummary;
    figure_analyses?: FigureAnalysis[];
    table_analyses?: TableAnalysis[];
    code_analyses?: CodeAnalysis[];
    skipped_steps?: Record<string, unknown>[];
    assumptions_cooldown_until?: number;
  };
}

export interface PaperFrontMatterData {
  title: string;
  venue?: string;
  doi?: string;
  authors: Array<{
    name: string;
    superscripts?: string[];
    corresponding?: boolean;
    email?: string;
  }>;
  affiliations: Array<{
    tag?: string;
    text: string;
  }>;
  abstract?: string;
}

export interface PaperMarkdownResponse {
  markdown: string;
  page_markdown: string[];
  images: Array<{ id: string; page: number; bbox?: number[] | null; caption?: string }>;
  ocr_status: string;
  front_matter?: PaperFrontMatterData | null;
}

export interface PaperListEntry {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  authors: string[];
  notes_count: number;
}

export interface Definition {
  term: string;
  definition: string;
  source: string;
}

export interface ResearchQuestion {
  question: string;
  context: string;
}

export interface PriorWork {
  title: string;
  relevance: string;
  ref_id: string;
  /** Full bibliography line extracted from PDF when available — shown instead of ``title``. */
  citation_display?: string;
  /** Model-extracted canonical https link when confidently known */
  url?: string;
  bib_label?: string;
  doi?: string;
  arxiv?: string;
  /** Denormalized theme when flattened from topic groups */
  theme?: string;
}

export interface Concept {
  name: string;
  description: string;
  importance: string;
}

export interface PriorWorkTopic {
  theme: string;
  summary: string;
  items: PriorWork[];
}

export interface PreReadingAnalysis {
  definitions: Definition[];
  research_questions: ResearchQuestion[];
  prior_work: PriorWork[];
  prior_work_topics?: PriorWorkTopic[];
  concepts: Concept[];
}

export interface Assumption {
  statement: string;
  type: string;
  section: string;
}

export interface DerivationStep {
  step_number: number;
  prompt: string;
  answer: string;
  expression: string;
  explanation: string;
  hint: string;
}

export interface DerivationExercise {
  title: string;
  original_section: string;
  starting_point: string;
  final_result: string;
  steps: DerivationStep[];
}

export interface QAItem {
  question: string;
  answer: string;
  sources?: QASourceHit[];
}

export interface ExplainResponse {
  term: string;
  explanation: string;
  source: string;
  in_paper: boolean;
}

export interface SearchResult {
  section: string;
  snippet: string;
  match_type: string;
}

export interface SelectionAnalysisResult {
  action: string;
  selected_text: string;
  question?: string;
  explanation?: string;
  elaboration?: string;
  answer?: string;
  assumptions?: { statement: string; type: string; significance: string }[];
  title?: string;
  starting_point?: string;
  final_result?: string;
  steps?: DerivationStep[];
  streaming?: boolean;
  /** Stable id for in-flight streams so threaded UI + history stay keyed while text grows */
  clientKey?: string;
  model?: string;
  created_at?: number;
  /** Normalized page-local highlight geometry captured at selection time. */
  regions?: Array<{
    pageNum: number;
    xPct: number;
    yPct: number;
    wPct: number;
    hPct: number;
  }>;
}

export interface SettingsResponse {
  has_anthropic_key: boolean;
  has_openai_key?: boolean;
  has_mistral_key?: boolean;
  analysis_model: string;
  fast_model: string;
  background_preset?: string | null;
  background_opacity?: number | null;
  deep_analysis_enabled?: boolean;
  deep_analysis_allowed?: boolean;
  deep_multiplier?: number;
  tier?: string;
  tier_limits?: Record<string, unknown> | null;
}

export interface Highlight {
  id: string;
  paper_id: string;
  selected_text: string;
  color: "yellow" | "green" | "blue" | "pink";
  note?: string | null;
  page_hint?: number | null;
  created_at?: string;
}

export interface ReadingStateRow {
  user_id?: string;
  paper_id?: string;
  last_page: number;
  last_tab: string | null;
  scroll_pct: number | null;
  updated_at?: string;
}

export interface ExportRow {
  id: string;
  paper_id: string;
  format: "pdf" | "pptx" | "podcast";
  status: "pending" | "running" | "completed" | "failed";
  sections: string[];
  storage_path: string | null;
  byte_size: number | null;
  duration_s: number | null;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  completed_at: string | null;
  download_url?: string | null;
}

export interface QASourceHit {
  paper_id: string;
  chunk_index: number;
  snippet: string;
  section?: string | null;
  similarity?: number | null;
}

export interface CitedByItem {
  title: string;
  year?: number | null;
  authors?: string[];
  url?: string;
  doi?: string;
  arxiv?: string;
  s2_id?: string;
  citation_count?: number | null;
}

export interface PaperSummary {
  // All fields optional. The migrated summary-stream route's schema
  // marks them optional too because Anthropic legitimately omits
  // sections that don't apply (e.g. "limitations" on a short
  // commentary paper, "key_figures_and_tables" on text-only work).
  // Renderers already short-circuit on falsy / empty values.
  overview?: string;
  tl_dr?: string;
  motivation?: string;
  key_contributions?: string[];
  methodology?: string;
  main_results?: string;
  discussion?: string;
  limitations?: string[];
  future_work?: string;
  key_equations?: { equation: string; meaning: string }[];
  key_figures_and_tables?: { id: string; description: string }[];
  model?: string;
  created_at?: number;
}

export interface FigureAnalysis {
  figure_id: string;
  question: string;
  description: string;
  answer?: string;
  key_observations: string[];
  methodology_shown?: string;
  relation_to_paper: string;
  takeaway?: string;
  model?: string;
  created_at?: number;
}

export interface TableAnalysis {
  table_id: string;
  table_label?: string;
  question?: string;
  answer: string;
  summary?: string | null;
  model?: string;
  created_at?: number;
}

export interface CodeAnalysis {
  block_id: string;
  language?: string;
  question?: string;
  algorithm_explanation: string;
  implementation: string;
  sketch_note?: string | null;
  model?: string;
  created_at?: number;
}

/** Cross-paper Q&A result (workspace session or saved workspace). */
export interface CrossPaperQA {
  question: string;
  answer: string;
  /** Sorted paper IDs in the session at the time this question was asked. */
  asked_against?: string[];
  /** Display-only: paper titles indexed to match `asked_against`. */
  asked_against_titles?: string[];
  /** Unix ms timestamp the answer was generated. */
  created_at?: number;
  /** Retrieved chunks that grounded this answer (Anchored Q&A). */
  sources?: QASourceHit[];
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  paper_ids: string[];
  cross_paper_results: CrossPaperQA[];
  updated_at: string;
}

export const api = {
  uploadPaper: async (file: File): Promise<ParsedPaper> => {
    const formData = new FormData();
    formData.append("file", file);
    const headers = await authHeaders();
    const res = await fetch(`${API_BASE}/api/papers/upload`, {
      method: "POST",
      headers,
      body: formData,
    });
    if (res.status === 401) {
      window.location.href = "/sign-in";
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Upload failed (${res.status}): ${detail}`);
    }
    return res.json();
  },

  listPapers: () => getRequest<PaperListEntry[]>("/api/papers/"),

  getPaper: (id: string) => getRequest<ParsedPaper>(`/api/papers/${id}`),

  getPaperMarkdown: (id: string) =>
    getRequest<PaperMarkdownResponse>(`/api/papers/${id}/markdown`),

  runPaperOcr: (id: string) =>
    request<{ ocr_status: string; markdown_length: number }>(`/api/papers/${id}/ocr/run`, {
      method: "POST",
    }),

  getOcrImageUrl: (paperId: string, imageId: string, trial = false) =>
    trial
      ? `${API_BASE}/api/trial/paper/${paperId}/ocr-image/${imageId}`
      : `/api/papers/${paperId}/ocr-image/${imageId}`,

  getTrialPaperMarkdown: (id: string) =>
    fetch(`${API_BASE}/api/trial/paper/${id}/markdown`).then(async (res) => {
      if (!res.ok) throw new Error("Failed to load markdown");
      return res.json() as Promise<PaperMarkdownResponse>;
    }),

  getPdfUrl: (id: string) => `/api/papers/${id}/pdf`,

  deletePaper: (id: string) =>
    request<{ status: string }>(`/api/papers/${id}`, { method: "DELETE" }),

  updateTags: async (id: string, tags: string[]) => {
    const res = await request<{ status: string }>(`/api/papers/${id}/tags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    });
    invalidatePaper(id);
    return res;
  },

  updateFolder: async (id: string, folder: string) => {
    const res = await request<{ status: string }>(`/api/papers/${id}/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    invalidatePaper(id);
    return res;
  },

  updateTitle: async (id: string, title: string) => {
    const res = await request<{ status: string; id: string; title: string }>(
      `/api/papers/${id}/title`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      },
    );
    invalidatePaper(id);
    return res;
  },

  addNote: (id: string, text: string, section: string = "", refine = false) =>
    request<Note>(`/api/papers/${id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, section, refine }),
    }),

  updateNote: (paperId: string, noteId: string, text: string) =>
    request<Note>(`/api/papers/${paperId}/notes/${noteId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),

  deleteNote: (paperId: string, noteId: string) =>
    request<{ status: string }>(`/api/papers/${paperId}/notes/${noteId}`, {
      method: "DELETE",
    }),

  analyzeSelection: (
    id: string,
    selectedText: string,
    action: string,
    extra?: {
      question?: string;
      signal?: AbortSignal;
      imageBase64?: string;
      regions?: SelectionAnalysisResult["regions"];
      model?: string;
    },
  ) =>
    request<SelectionAnalysisResult>(`/api/papers/${id}/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selected_text: selectedText,
        action,
        question: extra?.question,
        image_base64: extra?.imageBase64,
        regions: extra?.regions,
        model: extra?.model,
      }),
      signal: extra?.signal,
    }),

  deleteSelection: (id: string, selectedText: string, action: string) =>
    request<{ ok: boolean; removed_note_ids?: string[] }>(`/api/papers/${id}/selection`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected_text: selectedText, action }),
    }),

  analyzeSelectionStream: async (
    id: string,
    selectedText: string,
    action: string,
    options?: {
      signal?: AbortSignal;
      question?: string;
      model?: string;
      imageBase64?: string;
    },
  ) => {
    const headers = await authHeaders();
    const body: Record<string, unknown> = { selected_text: selectedText, action };
    if (options?.question) body.question = options.question;
    if (options?.model) body.model = options.model;
    if (options?.imageBase64) body.image_base64 = options.imageBase64;
    return fetch(`${API_BASE}/api/papers/${id}/selection-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  },

  /** Anonymous trial: Explain/Derive only; server enforces a low per-paper cap. */
  trialAnalyzeSelectionStream: async (
    paperId: string,
    selectedText: string,
    action: string,
    options?: { signal?: AbortSignal },
  ) =>
    fetch(`${API_BASE}/api/trial/selection-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paper_id: paperId,
        selected_text: selectedText,
        action,
      }),
      signal: options?.signal,
    }),

  analyze: (id: string) =>
    request<PreReadingAnalysis>(`/api/papers/${id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),

  explain: (id: string, term: string, context: string) =>
    request<ExplainResponse>(`/api/papers/${id}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term, context }),
    }),

  getAssumptions: (id: string) =>
    request<{ assumptions: Assumption[] }>(`/api/papers/${id}/assumptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),

  getSummary: (id: string, options?: { signal?: AbortSignal }) =>
    request<PaperSummary>(`/api/papers/${id}/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: options?.signal,
    }),

  /** Fast summary preview on Railway (avoids Vercel 60s Hobby timeout). */
  getSummaryLite: (id: string, options?: { signal?: AbortSignal; model?: string }) =>
    request<PaperSummary>(`/api/papers/${id}/summary-lite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options?.model ? { model: options.model } : {}),
      signal: options?.signal,
    }),

  getSummaryDeep: (id: string, options?: { signal?: AbortSignal; model?: string }) =>
    request<PaperSummary>(`/api/papers/${id}/summary-deep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options?.model ? { model: options.model } : {}),
      signal: options?.signal,
    }),

  /** Primary summary path — Railway batch (lite + deep in one call when phase=full). */
  generateSummary: (
    id: string,
    options?: {
      signal?: AbortSignal;
      phase?: "full" | "lite" | "deep";
      fastModel?: string;
      analysisModel?: string;
    },
  ) =>
    request<PaperSummary>(`/api/papers/${id}/summary-generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phase: options?.phase ?? "full",
        ...(options?.fastModel ? { fast_model: options.fastModel } : {}),
        ...(options?.analysisModel ? { analysis_model: options.analysisModel } : {}),
      }),
      signal: options?.signal,
    }),

  /** Stream the lite summary preview as progressive JSON objects (SSE). */
  streamSummaryLite: async (
    id: string,
    options?: { signal?: AbortSignal; model?: string },
  ) => {
    const headers = await authHeaders();
    return fetch(`${API_BASE}/api/papers/${id}/summary-lite-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(options?.model ? { model: options.model } : {}),
      signal: options?.signal,
    });
  },

  /** Stream the deep summary body as progressive JSON objects (SSE). */
  streamSummaryDeep: async (
    id: string,
    options?: { signal?: AbortSignal; model?: string },
  ) => {
    const headers = await authHeaders();
    return fetch(`${API_BASE}/api/papers/${id}/summary-deep-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(options?.model ? { model: options.model } : {}),
      signal: options?.signal,
    });
  },

  analyzeFigure: (id: string, figureId: string, question: string = "") =>
    request<FigureAnalysis>(`/api/papers/${id}/figure-qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ figure_id: figureId, question }),
    }),

  analyzeFigureStream: async (
    id: string,
    figureId: string,
    question: string = "",
    options?: { signal?: AbortSignal; model?: string },
  ) => {
    const headers = await authHeaders();
    const body: Record<string, unknown> = { figure_id: figureId, question };
    if (options?.model) body.model = options.model;
    return fetch(`${API_BASE}/api/papers/${id}/figure-qa-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  },

  analyzeTableStream: async (
    id: string,
    tableId: string,
    tableMarkdown: string,
    tableLabel: string,
    question: string = "",
    options?: { signal?: AbortSignal; model?: string },
  ) => {
    const headers = await authHeaders();
    const body: Record<string, unknown> = {
      table_id: tableId,
      table_markdown: tableMarkdown,
      table_label: tableLabel,
      question,
    };
    if (options?.model) body.model = options.model;
    return fetch(`/api/papers/${id}/table-qa-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  },

  analyzeCodeStream: async (
    id: string,
    blockId: string,
    code: string,
    language: string,
    contextLine: string,
    question: string = "",
    options?: { signal?: AbortSignal; model?: string },
  ) => {
    const headers = await authHeaders();
    const body: Record<string, unknown> = {
      block_id: blockId,
      code,
      language,
      context_line: contextLine,
      question,
    };
    if (options?.model) body.model = options.model;
    return fetch(`/api/papers/${id}/code-analyze-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  },

  getFigureUrl: (paperId: string, figId: string) =>
    `${API_BASE}/api/papers/${paperId}/figures/${figId}`,

  reextractFigures: async (id: string) => {
    const res = await request<{ status: string; figures_count: number; figures: FigureInfo[] }>(
      `/api/papers/${id}/reextract-figures`,
      { method: "POST" },
    );
    invalidatePaper(id);
    return res;
  },

  uploadFigureFromSelection: async (paperId: string, png: Blob) => {
    const form = new FormData();
    form.append("file", png, "selection.png");
    return request<{ figure: FigureInfo; figures: FigureInfo[] }>(
      `/api/papers/${paperId}/figures/from-selection`,
      {
        method: "POST",
        body: form,
      },
    );
  },

  getDerivationExercise: (id: string, section: string) =>
    request<DerivationExercise>(
      `/api/papers/${id}/derivation/exercise`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section }),
      }
    ),

  askQuestions: (id: string, questions: string[]) =>
    request<{ items: QAItem[] }>(`/api/papers/${id}/qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions }),
    }),

  suggestQuestions: (id: string, exclude: string[] = []) =>
    request<{ questions: string[] }>(`/api/papers/${id}/qa/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exclude }),
    }),

  askQuestionsMulti: (paperIds: string[], questions: string[]) =>
    request<{ items: QAItem[] }>(`/api/papers/multi-qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_ids: paperIds, questions }),
    }),

  search: (id: string, query: string) =>
    getRequest<{ query: string; results: SearchResult[] }>(
      `/api/papers/${id}/search?q=${encodeURIComponent(query)}`
    ),

  getCitedBy: (id: string) =>
    getRequest<{ items: CitedByItem[]; cached?: boolean; error?: string }>(
      `/api/papers/${id}/cited_by`,
    ),

  listHighlights: (id: string) =>
    getRequest<{ items: Highlight[] }>(`/api/papers/${id}/highlights`),

  createHighlight: (
    id: string,
    body: { selected_text: string; color: string; note?: string; page_hint?: number },
  ) =>
    request<Highlight>(`/api/papers/${id}/highlights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  updateHighlight: (id: string, highlightId: string, body: { color?: string; note?: string }) =>
    request<Highlight>(`/api/papers/${id}/highlights/${highlightId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  deleteHighlight: (id: string, highlightId: string) =>
    request<{ status: string }>(`/api/papers/${id}/highlights/${highlightId}`, {
      method: "DELETE",
    }),

  getReadingState: (id: string) =>
    // First visit returns 404; persistent infra glitch returns 5xx. Either way
    // we just want defaults — restore is best-effort, never a hard failure.
    getRequest<ReadingStateRow | null>(`/api/papers/${id}/reading-state`).catch(() => null),

  putReadingState: (
    id: string,
    body: { last_page?: number; last_tab?: string | null; scroll_pct?: number | null },
  ) =>
    request<ReadingStateRow>(`/api/papers/${id}/reading-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  requestExport: (
    paperId: string,
    body: {
      format: "pdf" | "pptx" | "podcast";
      sections: string[];
      options?: Record<string, unknown>;
    },
  ) =>
    request<{ export_id: string }>(`/api/papers/${paperId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  getExport: (exportId: string) => getRequest<ExportRow>(`/api/exports/${exportId}`),

  listExports: (limit = 20) =>
    getRequest<{ items: ExportRow[] }>(`/api/exports?limit=${limit}`),

  deleteExport: (exportId: string) =>
    request<{ status: string }>(`/api/exports/${exportId}`, { method: "DELETE" }),

  getSettings: () => getRequest<SettingsResponse>("/api/settings"),

  updateSettings: async (data: {
    anthropic_api_key?: string;
    analysis_model?: string;
    fast_model?: string;
    background_preset?: string;
    background_opacity?: number;
    deep_analysis_enabled?: boolean;
  }) => {
    const result = await request<SettingsResponse>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    // Stream routes cache prefs server-side; bust after a Settings save.
    if (typeof window !== "undefined") {
      try {
        await fetch("/api/user/invalidate-prefs", {
          method: "POST",
          credentials: "include",
        });
      } catch {
        /* best-effort */
      }
    }
    return result;
  },

  getModels: () => getRequest<{ models: string[] }>("/api/settings/models"),

  getCurrentUser: () =>
    getRequest<{ user_id: string; tier: string; paper_count: number; has_billing: boolean; cancel_at_period_end: boolean; cancel_at: number | null }>("/api/user/me"),

  createCheckoutSession: (tier: string, successUrl?: string, cancelUrl?: string) =>
    request<{ url: string; session_id: string }>("/api/billing/checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, success_url: successUrl, cancel_url: cancelUrl }),
    }),

  createPortalSession: (returnUrl?: string) =>
    request<{ url: string }>("/api/billing/portal-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ return_url: returnUrl }),
    }),

  cancelSubscription: (reason: string, feedback: string) =>
    request<{ status: string; cancel_at: number; message: string }>("/api/billing/cancel-subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, feedback }),
    }),

  resubscribe: () =>
    request<{ status: string; message: string }>("/api/billing/resubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),

  previewUpgrade: (tier: string) =>
    request<{
      currency: string;
      immediate_charge_cents: number;
      next_cycle_charge_cents: number;
      period_end: number | null;
      current_tier: string;
      target_tier: string;
      current_price_id: string;
      new_price_id: string;
    }>("/api/billing/upgrade-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    }),

  upgradeSubscription: (tier: string, when: "now" | "next_cycle" = "now") =>
    request<{ status: string; tier: string; effective_at: string | number; scheduled_for?: number }>(
      "/api/billing/upgrade",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, when }),
      },
    ),

  submitFeedback: (message: string) =>
    request<{ status: string }>("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),

  listWorkspaces: () =>
    getRequest<WorkspaceRecord[]>("/api/workspaces"),

  saveWorkspace: (data: {
    id?: string;
    name: string;
    paper_ids: string[];
    cross_paper_results: CrossPaperQA[];
  }) =>
    request<WorkspaceRecord>("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  deleteWorkspace: (id: string) =>
    request<{ status: string }>(`/api/workspaces/${id}`, { method: "DELETE" }),

  exportBibtex: (opts: { paper_ids?: string[]; folder?: string; workspace_id?: string }) =>
    request<{ bibtex: string; count: number }>("/api/export/bibtex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),

  getPaperUsage: (paperId: string) =>
    getRequest<{
      qa_used: number;
      qa_limit: number;
      selections_used: number;
      selections_limit: number;
      tier: string;
    }>(`/api/usage/${paperId}`),

  getAccountUsage: () =>
    getRequest<{
      tier: string;
      papers_used: number;
      papers_limit: number;
      daily_api_used: number;
      daily_api_limit: number;
      qa_per_paper_limit: number;
      selections_per_paper_limit: number;
      per_model_usage: { model: string; used: number; limit: number }[];
      per_capability_usage: {
        capability: string;
        label: string;
        used: number;
        limit: number;
      }[];
    }>(`/api/usage`),
};
