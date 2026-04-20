import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ParsedPaper,
  PreReadingAnalysis,
  QAItem,
  DerivationExercise,
  Assumption,
  SearchResult,
  Note,
  SelectionAnalysisResult,
  PaperSummary,
} from "./api";

interface PaperCache {
  preReading: PreReadingAnalysis | null;
  assumptions: Assumption[];
  summary: PaperSummary | null;
  notes: Note[];
  selectionHistory: SelectionAnalysisResult[];
  qaResults: QAItem[];
  questions: string[];
}

interface CrossPaperQA {
  question: string;
  answer: string;
}

interface AppStore {
  paper: ParsedPaper | null;
  setPaper: (p: ParsedPaper | null) => void;

  sessionPapers: { id: string; title: string }[];
  addSessionPaper: (p: { id: string; title: string }) => void;
  removeSessionPaper: (id: string) => void;
  clearSession: () => void;

  crossPaperResults: CrossPaperQA[];
  addCrossPaperResults: (items: CrossPaperQA[]) => void;
  clearCrossPaperResults: () => void;

  loading: boolean;
  setLoading: (l: boolean) => void;

  activeTab: string;
  setActiveTab: (t: string) => void;

  panelVisible: boolean;
  setPanelVisible: (v: boolean) => void;
  togglePanel: () => void;

  selectionResult: SelectionAnalysisResult | null;
  setSelectionResult: (r: SelectionAnalysisResult | null) => void;
  selectionLoading: boolean;
  setSelectionLoading: (l: boolean) => void;
  selectionHistory: SelectionAnalysisResult[];
  addSelectionToHistory: (r: SelectionAnalysisResult) => void;

  preReading: PreReadingAnalysis | null;
  setPreReading: (p: PreReadingAnalysis | null) => void;
  preReadingLoading: boolean;
  setPreReadingLoading: (l: boolean) => void;

  questions: string[];
  addQuestion: (q: string) => void;
  removeQuestion: (idx: number) => void;
  clearQuestions: () => void;
  qaResults: QAItem[];
  setQAResults: (items: QAItem[]) => void;
  qaLoading: boolean;
  setQALoading: (l: boolean) => void;

  exercise: DerivationExercise | null;
  setExercise: (e: DerivationExercise | null) => void;
  exerciseLoading: boolean;
  setExerciseLoading: (l: boolean) => void;

  assumptions: Assumption[];
  setAssumptions: (a: Assumption[]) => void;
  assumptionsLoading: boolean;
  setAssumptionsLoading: (l: boolean) => void;

  searchResults: SearchResult[];
  setSearchResults: (r: SearchResult[]) => void;
  searchLoading: boolean;
  setSearchLoading: (l: boolean) => void;

  notes: Note[];
  setNotes: (n: Note[]) => void;
  addNote: (n: Note) => void;
  updateNote: (id: string, text: string) => void;
  removeNote: (id: string) => void;

  summary: PaperSummary | null;
  setSummary: (s: PaperSummary | null) => void;
  summaryLoading: boolean;
  setSummaryLoading: (l: boolean) => void;

  paperCaches: Record<string, PaperCache>;
  savePaperCache: (paperId: string) => void;
  restorePaperCache: (paperId: string) => boolean;
  clearPaperCache: (paperId: string) => void;
  updatePaperCache: (paperId: string, partial: Partial<PaperCache>) => void;
  resetAnalysisState: () => void;

  usageRefreshKey: number;
  bumpUsageRefresh: () => void;
}

export const useStore = create<AppStore>()(
  persist(
    (set, get) => ({
      paper: null,
      setPaper: (p) => set({ paper: p }),

      sessionPapers: [],
      addSessionPaper: (p) =>
        set((s) => {
          if (s.sessionPapers.some((sp) => sp.id === p.id)) return s;
          return { sessionPapers: [...s.sessionPapers, p] };
        }),
      removeSessionPaper: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.paperCaches;
          return {
            sessionPapers: s.sessionPapers.filter((sp) => sp.id !== id),
            paperCaches: rest,
          };
        }),
      clearSession: () => set({
        sessionPapers: [], paperCaches: {}, crossPaperResults: [],
        preReading: null, assumptions: [], summary: null, notes: [],
        selectionHistory: [], selectionResult: null, qaResults: [], questions: [],
        exercise: null, searchResults: [],
      }),

      crossPaperResults: [],
      addCrossPaperResults: (items) =>
        set((s) => ({ crossPaperResults: [...items, ...s.crossPaperResults].slice(0, 200) })),
      clearCrossPaperResults: () => set({ crossPaperResults: [] }),

      loading: false,
      setLoading: (l) => set({ loading: l }),

      activeTab: "summary",
      setActiveTab: (t) => set({ activeTab: t }),

      panelVisible: true,
      setPanelVisible: (v) => set({ panelVisible: v }),
      togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

      selectionResult: null,
      setSelectionResult: (r) => set({ selectionResult: r }),
      selectionLoading: false,
      setSelectionLoading: (l) => set({ selectionLoading: l }),
      selectionHistory: [],
      addSelectionToHistory: (r) =>
        set((s) => ({ selectionHistory: [r, ...s.selectionHistory].slice(0, 50) })),

      preReading: null,
      setPreReading: (p) => set({ preReading: p }),
      preReadingLoading: false,
      setPreReadingLoading: (l) => set({ preReadingLoading: l }),

      questions: [],
      addQuestion: (q) => set((s) => ({ questions: [...s.questions, q] })),
      removeQuestion: (idx) =>
        set((s) => ({ questions: s.questions.filter((_, i) => i !== idx) })),
      clearQuestions: () => set({ questions: [] }),
      qaResults: [],
      setQAResults: (items) => set({ qaResults: items }),
      qaLoading: false,
      setQALoading: (l) => set({ qaLoading: l }),

      exercise: null,
      setExercise: (e) => set({ exercise: e }),
      exerciseLoading: false,
      setExerciseLoading: (l) => set({ exerciseLoading: l }),

      assumptions: [],
      setAssumptions: (a) => set({ assumptions: a }),
      assumptionsLoading: false,
      setAssumptionsLoading: (l) => set({ assumptionsLoading: l }),

      searchResults: [],
      setSearchResults: (r) => set({ searchResults: r }),
      searchLoading: false,
      setSearchLoading: (l) => set({ searchLoading: l }),

      notes: [],
      setNotes: (n) => set({ notes: n }),
      addNote: (n) => set((s) => ({ notes: [...s.notes, n] })),
      updateNote: (id, text) =>
        set((s) => ({
          notes: s.notes.map((n) => (n.id === id ? { ...n, text } : n)),
        })),
      removeNote: (id) =>
        set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),

      summary: null,
      setSummary: (s) => set({ summary: s }),
      summaryLoading: false,
      setSummaryLoading: (l) => set({ summaryLoading: l }),

      paperCaches: {},
      savePaperCache: (paperId: string) => {
        const s = get();
        const caches = { ...s.paperCaches };
        caches[paperId] = {
          preReading: s.preReading,
          assumptions: s.assumptions,
          summary: s.summary,
          notes: s.notes,
          selectionHistory: s.selectionHistory,
          qaResults: s.qaResults,
          questions: s.questions,
        };
        const keys = Object.keys(caches);
        if (keys.length > 20) {
          const oldest = keys.filter((k) => k !== paperId).slice(0, keys.length - 20);
          for (const k of oldest) delete caches[k];
        }
        set({ paperCaches: caches });
      },
      restorePaperCache: (paperId: string) => {
        const cached = get().paperCaches[paperId];
        if (!cached) return false;
        set({
          preReading: cached.preReading,
          assumptions: cached.assumptions,
          summary: cached.summary,
          notes: cached.notes,
          selectionHistory: cached.selectionHistory,
          qaResults: cached.qaResults,
          questions: cached.questions,
          selectionResult: null,
          exercise: null,
          searchResults: [],
          preReadingLoading: false,
          assumptionsLoading: false,
          summaryLoading: false,
          selectionLoading: false,
          qaLoading: false,
          exerciseLoading: false,
          searchLoading: false,
        });
        return true;
      },
      clearPaperCache: (paperId: string) => {
        const { [paperId]: _, ...rest } = get().paperCaches;
        set({ paperCaches: rest });
      },
      updatePaperCache: (paperId: string, partial: Partial<PaperCache>) => {
        const s = get();
        const existing = s.paperCaches[paperId] || {
          preReading: null, assumptions: [], summary: null,
          notes: [], selectionHistory: [], qaResults: [], questions: [],
        };
        set({
          paperCaches: {
            ...s.paperCaches,
            [paperId]: { ...existing, ...partial },
          },
        });
      },
      resetAnalysisState: () => set({
        preReading: null, assumptions: [], summary: null, notes: [],
        selectionHistory: [], selectionResult: null, qaResults: [], questions: [],
        exercise: null, searchResults: [],
        preReadingLoading: false, assumptionsLoading: false, summaryLoading: false,
        selectionLoading: false, qaLoading: false, exerciseLoading: false, searchLoading: false,
      }),

      usageRefreshKey: 0,
      bumpUsageRefresh: () => set((s) => ({ usageRefreshKey: s.usageRefreshKey + 1 })),
    }),
    {
      name: "know-paper-store",
      storage: {
        getItem: (name: string) => {
          try {
            const str = sessionStorage.getItem(name);
            return str ? JSON.parse(str) : null;
          } catch {
            sessionStorage.removeItem(name);
            return null;
          }
        },
        setItem: (name: string, value: unknown) => {
          try {
            sessionStorage.setItem(name, JSON.stringify(value));
          } catch {
            // sessionStorage quota exceeded — silently drop
          }
        },
        removeItem: (name: string) => sessionStorage.removeItem(name),
      },
      partialize: (state) => ({
        paperCaches: state.paperCaches,
        sessionPapers: state.sessionPapers,
        crossPaperResults: state.crossPaperResults,
      }),
    }
  )
);
