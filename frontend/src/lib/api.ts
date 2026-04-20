let _getToken: (() => Promise<string | null>) | null = null;
let _cachedToken: string | null = null;
let _tokenRefreshInterval: ReturnType<typeof setInterval> | null = null;

export function setClerkTokenGetter(fn: () => Promise<string | null>) {
  _getToken = fn;
  fn().then((t) => { _cachedToken = t; });
  clearTokenRefreshInterval();
  _tokenRefreshInterval = setInterval(() => {
    fn().then((t) => { _cachedToken = t; });
  }, 45_000);
}

export function clearTokenRefreshInterval() {
  if (_tokenRefreshInterval) {
    clearInterval(_tokenRefreshInterval);
    _tokenRefreshInterval = null;
  }
}

export function getAuthHeadersSync(): Record<string, string> {
  if (_getToken && _cachedToken) {
    _getToken().then((t) => { _cachedToken = t; });
  }
  return _cachedToken ? { Authorization: `Bearer ${_cachedToken}` } : {};
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function authHeaders(): Promise<Record<string, string>> {
  if (_getToken) {
    const token = await _getToken();
    _cachedToken = token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {};
}

// Matches the 429 detail emitted by backend `track_usage` when a per-model
// daily cap is hit: "Daily limit reached for <model> (<n>/day on <tier> plan)."
const MODEL_CAP_DETAIL_RE =
  /Daily limit reached for (\S+) \((\d+)\/day on (\S+) plan\)/;

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
    if (res.status === 401) {
      if (typeof window !== "undefined") {
        window.location.href = "/sign-in";
      }
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      const status = res.status;
      let detail: string;
      try {
        const body = await res.json();
        detail = body?.detail || `Request failed (${status})`;
      } catch {
        detail = `Request failed (${status})`;
      }

      // Per-model cap: prompt the user to switch and retry once.
      if (status === 429 && retryCount === 0) {
        const match = detail.match(MODEL_CAP_DETAIL_RE);
        if (match) {
          const [, cappedModel, limitStr, tier] = match;
          const { promptModelCap } = await import("./modelCapPrompt");
          const result = await promptModelCap({
            cappedModel,
            limit: parseInt(limitStr, 10) || 0,
            tier,
          });
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
              // If the model switch fails, fall through to the original error.
              throw new Error(detail);
            }
            return request<T>(path, options, retryCount + 1);
          }
        }
      }

      throw new Error(detail);
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

export interface FigureInfo {
  id: string;
  url: string;
  caption: string;
  page: number;
}

export interface Note {
  id: string;
  text: string;
  section: string;
  created_at: number;
}

export interface ParsedPaper {
  id: string;
  title: string;
  authors: string[];
  raw_text: string;
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
    summary?: PaperSummary;
    figure_analyses?: FigureAnalysis[];
    skipped_steps?: Record<string, unknown>[];
  };
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
}

export interface Concept {
  name: string;
  description: string;
  importance: string;
}

export interface PreReadingAnalysis {
  definitions: Definition[];
  research_questions: ResearchQuestion[];
  prior_work: PriorWork[];
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
  explanation?: string;
  elaboration?: string;
  answer?: string;
  assumptions?: { statement: string; type: string; significance: string }[];
  title?: string;
  starting_point?: string;
  final_result?: string;
  steps?: DerivationStep[];
  streaming?: boolean;
}

export interface SettingsResponse {
  has_anthropic_key: boolean;
  analysis_model: string;
  fast_model: string;
}

export interface PaperSummary {
  overview: string;
  motivation: string;
  key_contributions: string[];
  methodology: string;
  main_results: string;
  discussion: string;
  limitations: string[];
  future_work: string;
  key_equations: { equation: string; meaning: string }[];
  key_figures_and_tables: { id: string; description: string }[];
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

  listPapers: () => request<PaperListEntry[]>("/api/papers/"),

  getPaper: (id: string) => request<ParsedPaper>(`/api/papers/${id}`),

  getPdfUrl: (id: string) => `${API_BASE}/api/papers/${id}/pdf`,

  deletePaper: (id: string) =>
    request<{ status: string }>(`/api/papers/${id}`, { method: "DELETE" }),

  updateTags: (id: string, tags: string[]) =>
    request<{ status: string }>(`/api/papers/${id}/tags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
    }),

  updateFolder: (id: string, folder: string) =>
    request<{ status: string }>(`/api/papers/${id}/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    }),

  addNote: (id: string, text: string, section: string = "") =>
    request<Note>(`/api/papers/${id}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, section }),
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

  analyzeSelection: (id: string, selectedText: string, action: string) =>
    request<SelectionAnalysisResult>(`/api/papers/${id}/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected_text: selectedText, action }),
    }),

  analyzeSelectionStream: async (id: string, selectedText: string, action: string, signal?: AbortSignal) => {
    const headers = await authHeaders();
    return fetch(`${API_BASE}/api/papers/${id}/selection-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ selected_text: selectedText, action }),
      signal,
    });
  },

  analyze: (id: string) =>
    request<PreReadingAnalysis>(`/api/papers/${id}/analyze`, { method: "POST" }),

  explain: (id: string, term: string, context: string) =>
    request<ExplainResponse>(`/api/papers/${id}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term, context }),
    }),

  getAssumptions: (id: string) =>
    request<{ assumptions: Assumption[] }>(`/api/papers/${id}/assumptions`, {
      method: "POST",
    }),

  getSummary: (id: string) =>
    request<PaperSummary>(`/api/papers/${id}/summary`, {
      method: "POST",
    }),

  getSummaryStream: async (id: string, signal?: AbortSignal) => {
    const headers = await authHeaders();
    return fetch(`${API_BASE}/api/papers/${id}/summary-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      signal,
    });
  },

  analyzeFigure: (id: string, figureId: string, question: string = "") =>
    request<FigureAnalysis>(`/api/papers/${id}/figure-qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ figure_id: figureId, question }),
    }),

  analyzeFigureStream: async (id: string, figureId: string, question: string = "", signal?: AbortSignal) => {
    const headers = await authHeaders();
    return fetch(`${API_BASE}/api/papers/${id}/figure-qa-stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ figure_id: figureId, question }),
      signal,
    });
  },

  getFigureUrl: (paperId: string, figId: string) =>
    `${API_BASE}/api/papers/${paperId}/figures/${figId}`,

  reextractFigures: (id: string) =>
    request<{ status: string; figures_count: number; figures: FigureInfo[] }>(
      `/api/papers/${id}/reextract-figures`,
      { method: "POST" }
    ),

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

  askQuestionsMulti: (paperIds: string[], questions: string[]) =>
    request<{ items: QAItem[] }>(`/api/papers/multi-qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_ids: paperIds, questions }),
    }),

  search: (id: string, query: string) =>
    request<{ query: string; results: SearchResult[] }>(
      `/api/papers/${id}/search?q=${encodeURIComponent(query)}`
    ),

  getSettings: () => request<SettingsResponse>("/api/settings"),

  updateSettings: (data: {
    anthropic_api_key?: string;
    analysis_model?: string;
    fast_model?: string;
  }) =>
    request<SettingsResponse>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),

  getModels: () => request<{ models: string[] }>("/api/settings/models"),

  getCurrentUser: () =>
    request<{ user_id: string; tier: string; paper_count: number; has_billing: boolean; cancel_at_period_end: boolean; cancel_at: number | null }>("/api/user/me"),

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

  upgradeSubscription: (tier: string) =>
    request<{ status: string; tier: string }>("/api/billing/upgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier }),
    }),

  submitFeedback: (message: string) =>
    request<{ status: string }>("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),

  listWorkspaces: () =>
    request<{ id: string; name: string; paper_ids: string[]; cross_paper_results: { question: string; answer: string }[]; updated_at: string }[]>("/api/workspaces"),

  saveWorkspace: (data: {
    id?: string;
    name: string;
    paper_ids: string[];
    cross_paper_results: { question: string; answer: string }[];
  }) =>
    request<{ id: string; name: string; paper_ids: string[]; cross_paper_results: { question: string; answer: string }[]; updated_at: string }>("/api/workspaces", {
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
    request<{
      qa_used: number;
      qa_limit: number;
      selections_used: number;
      selections_limit: number;
      tier: string;
    }>(`/api/usage/${paperId}`),

  getAccountUsage: () =>
    request<{
      tier: string;
      papers_used: number;
      papers_limit: number;
      daily_api_used: number;
      daily_api_limit: number;
      qa_per_paper_limit: number;
      selections_per_paper_limit: number;
      per_model_usage: { model: string; used: number; limit: number }[];
    }>(`/api/usage`),
};
