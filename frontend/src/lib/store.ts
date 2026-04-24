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

  // Cache of full ParsedPaper objects keyed by id — lets us show a paper
  // instantly while a background refresh runs.
  papersById: Record<string, ParsedPaper>;
  cachePaper: (p: ParsedPaper) => void;
  getCachedPaper: (id: string) => ParsedPaper | undefined;

  // Per-paper flag for "figure re-extraction in progress". Lives in
  // the global store (not FiguresPanel local state) so switching
  // papers mid-job and returning still shows the spinner instead of
  // looking like the job silently died.
  figureReextractInFlight: Record<string, boolean>;
  setFigureReextractInFlight: (paperId: string, running: boolean) => void;

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

  // Reader chrome state. `headerHidden` collapses the top navbar/session
  // bar without entering browser fullscreen, so the user can reclaim
  // vertical space while keeping window controls. `focusMode` is the
  // stronger "disappear everything" toggle — it implies headerHidden
  // and also requests the browser Fullscreen API when available.
  // Both persist so the reader opens in the last-used chrome state.
  headerHidden: boolean;
  setHeaderHidden: (v: boolean) => void;
  toggleHeader: () => void;
  focusMode: boolean;
  setFocusMode: (v: boolean) => void;
  toggleFocusMode: () => void;

  // Analysis-pane font scale. 1.0 == default (~14px). Persists so the
  // user's preferred reading size survives refresh. Capped server-side
  // to [0.85, 1.6] to avoid layout break.
  analysisFontScale: number;
  setAnalysisFontScale: (v: number) => void;
  bumpAnalysisFontScale: (delta: number) => void;

  selectionResult: SelectionAnalysisResult | null;
  setSelectionResult: (r: SelectionAnalysisResult | null) => void;
  selectionLoading: boolean;
  setSelectionLoading: (l: boolean) => void;
  selectionHistory: SelectionAnalysisResult[];
  addSelectionToHistory: (r: SelectionAnalysisResult) => void;
  // Surface a past selection in the analysis pane — used when the user
  // clicks an existing underline in the PDF. Pins the pane open, jumps
  // to the Selection tab, and sets the active result.
  openSelectionFromHistory: (r: SelectionAnalysisResult) => void;
  // Remove a highlight from the in-memory history. The backend
  // persistence step is handled by callers (via `api.deleteSelection`)
  // so this action stays synchronous and cheap.
  removeSelectionFromHistory: (r: SelectionAnalysisResult) => void;

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

      papersById: {},
      cachePaper: (p) =>
        set((s) => ({ papersById: { ...s.papersById, [p.id]: p } })),
      getCachedPaper: (id) => get().papersById[id],

      figureReextractInFlight: {},
      setFigureReextractInFlight: (paperId, running) =>
        set((s) => {
          const next = { ...s.figureReextractInFlight };
          if (running) next[paperId] = true;
          else delete next[paperId];
          return { figureReextractInFlight: next };
        }),

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
      clearSession: () => {
        set({
          sessionPapers: [], paperCaches: {}, crossPaperResults: [],
          papersById: {},
          preReading: null, assumptions: [], summary: null, notes: [],
          selectionHistory: [], selectionResult: null, qaResults: [], questions: [],
          exercise: null, searchResults: [],
        });
        // Drop the persisted blob too — otherwise signing out and signing
        // back in as a different user in the same browser would rehydrate
        // the previous user's papers from localStorage.
        if (typeof window !== "undefined") {
          try { localStorage.removeItem("know-paper-store"); } catch { /* best-effort */ }
          // Also clear the legacy sessionStorage key for anyone upgrading
          // from the previous release so stale data doesn't linger.
          try { sessionStorage.removeItem("know-paper-store"); } catch { /* best-effort */ }
        }
      },

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

      headerHidden: false,
      setHeaderHidden: (v) => set({ headerHidden: v }),
      toggleHeader: () => set((s) => ({ headerHidden: !s.headerHidden })),
      focusMode: false,
      setFocusMode: (v) => set({ focusMode: v }),
      toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),

      analysisFontScale: 1,
      setAnalysisFontScale: (v) =>
        set({ analysisFontScale: Math.max(0.85, Math.min(1.6, v)) }),
      bumpAnalysisFontScale: (delta) =>
        set((s) => ({
          analysisFontScale: Math.max(0.85, Math.min(1.6, +(s.analysisFontScale + delta).toFixed(2))),
        })),

      selectionResult: null,
      setSelectionResult: (r) => set({ selectionResult: r }),
      selectionLoading: false,
      setSelectionLoading: (l) => set({ selectionLoading: l }),
      selectionHistory: [],
      addSelectionToHistory: (r) =>
        set((s) => ({ selectionHistory: [r, ...s.selectionHistory].slice(0, 50) })),
      openSelectionFromHistory: (r) =>
        set({
          selectionResult: r,
          selectionLoading: false,
          activeTab: "selection",
          panelVisible: true,
        }),
      removeSelectionFromHistory: (r) =>
        set((s) => {
          const key = (x: SelectionAnalysisResult) =>
            `${x.action ?? "explain"}::${(x.selected_text ?? "").trim()}`;
          const target = key(r);
          return {
            selectionHistory: s.selectionHistory.filter((h) => key(h) !== target),
            selectionResult:
              s.selectionResult && key(s.selectionResult) === target
                ? null
                : s.selectionResult,
          };
        }),

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
      // Cap QA history to the most recent 200 items so the panel — and the
      // persisted blob in sessionStorage — can't grow unbounded in long
      // reading sessions.
      setQAResults: (items) => set({ qaResults: items.slice(-200) }),
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
      // localStorage survives tab close/reopen (sessionStorage does not),
      // so the session-paper list and cross-paper results come back when
      // the user returns to the app later. Analysis state is NOT kept here
      // — it's always hydrated from the backend on paper load.
      storage: {
        getItem: (name: string) => {
          try {
            const str = localStorage.getItem(name);
            return str ? JSON.parse(str) : null;
          } catch {
            try { localStorage.removeItem(name); } catch { /* ignore */ }
            return null;
          }
        },
        setItem: (name: string, value: unknown) => {
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch {
            // localStorage quota exceeded — silently drop; next page load
            // will still work (just re-fetches from backend).
          }
        },
        removeItem: (name: string) => {
          try { localStorage.removeItem(name); } catch { /* ignore */ }
        },
      },
      // The server is the source of truth for every analysis artifact:
      // `paper.cached_analysis` is re-hydrated on each mount, so we do NOT
      // persist `paperCaches` (previously did — caused stale/ghost data
      // when a user returned hours later or the browser swapped sessions).
      // We only persist lightweight UX state: the multi-paper session list
      // and cross-paper QA results, which have no server mirror.
      partialize: (state) => ({
        sessionPapers: state.sessionPapers,
        crossPaperResults: state.crossPaperResults,
        // Chrome preferences survive reloads so the reader feels "sticky":
        // if the user worked in focus mode last session, they return to it
        // instead of re-picking it every time. Intentionally excludes
        // `panelVisible` (already persisted elsewhere in this store).
        headerHidden: state.headerHidden,
        focusMode: state.focusMode,
        analysisFontScale: state.analysisFontScale,
      }),
    }
  )
);
