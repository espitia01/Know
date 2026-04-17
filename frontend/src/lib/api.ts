const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`API error ${res.status}: ${detail}`);
  }
  return res.json();
}

export interface FigureInfo {
  id: string;
  url: string;
  caption: string;
  page: number;
}

export interface Reference {
  id: string;
  text: string;
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
  affiliations: string[];
  abstract: string;
  content_markdown: string;
  figures: FigureInfo[];
  references: Reference[];
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

export interface SettingsResponse {
  has_anthropic_key: boolean;
  local_model_url: string;
  local_model_name: string;
  active_provider: string;
}

export const api = {
  uploadPaper: async (file: File): Promise<ParsedPaper> => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/api/papers/upload`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
    return res.json();
  },

  listPapers: () => request<PaperListEntry[]>("/api/papers/"),

  getPaper: (id: string) => request<ParsedPaper>(`/api/papers/${id}`),

  deletePaper: (id: string) =>
    request<{ status: string }>(`/api/papers/${id}`, { method: "DELETE" }),

  movePaperToFolder: (id: string, folder: string) =>
    request<{ status: string }>(`/api/papers/${id}/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    }),

  updateTags: (id: string, tags: string[]) =>
    request<{ status: string }>(`/api/papers/${id}/tags`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
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

  getFigureUrl: (paperId: string, figId: string) =>
    `${API_BASE}/api/papers/${paperId}/figures/${figId}`,

  analyze: (id: string) =>
    request<PreReadingAnalysis>(`/api/papers/${id}/analyze`, { method: "POST" }),

  explain: (id: string, term: string, context: string) =>
    request<ExplainResponse>(`/api/papers/${id}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term, context }),
    }),

  getSkippedSteps: (id: string, section: string) =>
    request<{ section: string; filled_steps: DerivationStep[] }>(
      `/api/papers/${id}/skipped-steps`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section }),
      }
    ),

  getAssumptions: (id: string) =>
    request<{ assumptions: Assumption[] }>(`/api/papers/${id}/assumptions`, {
      method: "POST",
    }),

  uploadSI: async (paperId: string, file: File): Promise<ParsedPaper> => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/api/papers/${paperId}/si/upload`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`SI upload failed: ${res.statusText}`);
    return res.json();
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

  search: (id: string, query: string) =>
    request<{ query: string; results: SearchResult[] }>(
      `/api/papers/${id}/search?q=${encodeURIComponent(query)}`
    ),

  getSettings: () => request<SettingsResponse>("/api/settings"),

  updateSettings: (data: {
    anthropic_api_key?: string;
    local_model_url?: string;
    local_model_name?: string;
    active_provider?: string;
  }) =>
    request<SettingsResponse>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
};
