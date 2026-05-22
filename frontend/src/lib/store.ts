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
  Highlight,
  SelectionAnalysisResult,
  PaperSummary,
  CrossPaperQA,
} from "./api";
import { selectionKey as selectionResultKey } from "./selectionActions";
import { MAX_SESSION_PAPERS } from "./workspaceFeatureFlags";

/** Stable empty arrays for Zustand selectors — `?? []` creates a new ref every read. */
export const EMPTY_SELECTION_LIST: SelectionAnalysisResult[] = [];
export const EMPTY_QA_LIST: QAItem[] = [];
export const EMPTY_NOTES_LIST: Note[] = [];
export const EMPTY_HIGHLIGHTS_LIST: Highlight[] = [];

export type ReadingState = {
  last_page: number;
  last_tab: string | null;
  scroll_pct: number | null;
};

export type PendingPassage = {
  snippet: string;
  paper_id?: string;
  ts: number;
};
export const EMPTY_ASSUMPTIONS_LIST: Assumption[] = [];
export const EMPTY_SEARCH_LIST: SearchResult[] = [];

function selectionRowsEqual(
  a: SelectionAnalysisResult,
  b: SelectionAnalysisResult,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type ReaderPanelPosition = "right" | "left" | "bottom";

export type AnalysisFontFamily = "sans" | "serif" | "mono" | "times" | "arial";

export type PdfRegionHighlight = {
  id: string;
  pageNum: number;
  /** Normalized [0,1] page-local box so zoom does not move the overlay. */
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
};

interface UiPrefs {
  panelPos: ReaderPanelPosition;
  panelSizeSide: number;
  panelSizeBottom: number;
  hideQaSuggestions: boolean;
  scrollByPaper: Record<string, number>;
  qaDraftByPaper: Record<string, string>;
  relatedView?: "graph" | "list";
}

interface AppStore {
  paper: ParsedPaper | null;
  setPaper: (p: ParsedPaper | null) => void;

  /**
   * The id of the paper the user is currently looking at. Lives in the
   * store (not local React state) so streams, panels, and effects can
   * all read the same source of truth without prop-drilling through the
   * reader tree. Migrating away from per-component activePaperId state
   * is what makes workspaces possible — every analysis slice is now
   * keyed by paperId and panels read from the active slot.
   */
  activePaperId: string | null;
  setActivePaperId: (id: string | null) => void;

  // Cache of full ParsedPaper objects keyed by id — lets us show a paper
  // instantly while a background refresh runs.
  papersById: Record<string, ParsedPaper>;
  cachePaper: (p: ParsedPaper) => void;
  updateCachedAnalysis: (paperId: string, partial: Record<string, unknown>) => void;
  forgetCachedPaper: (paperId: string) => void;
  getCachedPaper: (id: string) => ParsedPaper | undefined;

  uiPrefs: UiPrefs;
  setPanelPosition: (pos: ReaderPanelPosition) => void;
  setPanelSize: (pos: ReaderPanelPosition, size: number) => void;
  setRelatedView: (view: "graph" | "list") => void;
  setHideQaSuggestions: (hidden: boolean) => void;
  setPdfScroll: (paperId: string, ratio: number) => void;
  setQADraft: (paperId: string, draft: string) => void;
  clearPaperUiPrefs: (paperId: string) => void;

  // Per-paper flag for "figure re-extraction in progress". Lives in
  // the global store (not FiguresPanel local state) so switching
  // papers mid-job and returning still shows the spinner instead of
  // looking like the job silently died.
  figureReextractInFlight: Record<string, boolean>;
  setFigureReextractInFlight: (paperId: string, running: boolean) => void;

  sessionPapers: { id: string; title: string }[];
  /**
   * Add a paper to the workspace session. Returns `true` if it was
   * added (or was already present — idempotent), `false` when the
   * MAX_SESSION_PAPERS cap would be exceeded. Callers surface their
   * own toast/error UI on `false`.
   */
  addSessionPaper: (p: { id: string; title: string }) => boolean;
  removeSessionPaper: (id: string) => void;
  clearSession: () => void;
  // Rename a paper in every in-memory representation at once: the
  // active `paper`, the per-id cache, and the session tab bar. The
  // server write is handled by the caller (via `api.updateTitle`) so
  // this action stays synchronous and optimistic.
  updatePaperTitle: (id: string, title: string) => void;

  crossPaperResults: CrossPaperQA[];
  addCrossPaperResults: (items: CrossPaperQA[]) => void;
  clearCrossPaperResults: () => void;

  loading: boolean;
  setLoading: (l: boolean) => void;

  activeTab: string;
  setActiveTab: (t: string) => void;

  marqueeMode: boolean;
  setMarqueeMode: (v: boolean) => void;

  /** Per-paper: pdf.js text layer empty on first pages (scanned PDF). Not persisted. */
  pdfTextLayerEmptyByPaper: Record<string, boolean>;
  setPdfTextLayerEmpty: (paperId: string, empty: boolean) => void;

  /** Page-local region boxes from marquee capture (scanned PDFs). Persisted in localStorage. */
  pdfRegionHighlightsByPaper: Record<string, PdfRegionHighlight[]>;
  addPdfRegionHighlight: (paperId: string, highlight: Omit<PdfRegionHighlight, "id">) => void;

  /** Viewer hands off marquee captures; FiguresPanel uploads then clears — not persisted */
  pendingFigureBlob: Blob | null;
  setPendingFigureBlob: (b: Blob | null) => void;
  /** Optional caption for the next pending figure (e.g. scanned PDF region capture). */
  pendingFigureCaption: string | null;
  setPendingFigureCaption: (caption: string | null) => void;

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

  analysisFontFamily: AnalysisFontFamily;
  setAnalysisFontFamily: (v: AnalysisFontFamily) => void;

  /**
   * Per-paper analysis state. Every slice below is keyed by paperId so
   * a slow background request for paper A cannot splatter into paper B's
   * panel after the user switched tabs. Panels read `*ByPaper[paperId]`
   * directly via the panel-level `paperId` prop. The legacy singleton
   * accessors still exist (as derived selectors via getters in the
   * actions) so older call sites keep compiling while we migrate.
   */
  selectionResultByPaper: Record<string, SelectionAnalysisResult | null>;
  setSelectionResultForPaper: (paperId: string, r: SelectionAnalysisResult | null) => void;
  selectionHistoryByPaper: Record<string, SelectionAnalysisResult[]>;
  upsertSelectionInHistoryForPaper: (paperId: string, r: SelectionAnalysisResult) => void;
  removeSelectionFromHistoryForPaper: (paperId: string, r: SelectionAnalysisResult) => void;
  openSelectionFromHistory: (paperId: string, r: SelectionAnalysisResult) => void;
  selectionLoadingByPaper: Record<string, boolean>;
  setSelectionLoadingForPaper: (paperId: string, loading: boolean) => void;

  preReadingByPaper: Record<string, PreReadingAnalysis | null>;
  setPreReadingForPaper: (paperId: string, preReading: PreReadingAnalysis | null) => void;
  preReadingLoadingByPaper: Record<string, boolean>;
  setPreReadingLoadingForPaper: (paperId: string, loading: boolean) => void;
  preReadingErrorByPaper: Record<string, string | null>;
  setPreReadingError: (paperId: string, message: string | null) => void;

  questions: string[];
  addQuestion: (q: string) => void;
  removeQuestion: (idx: number) => void;
  clearQuestions: () => void;
  qaResultsByPaper: Record<string, QAItem[]>;
  setQAResultsForPaper: (paperId: string, items: QAItem[]) => void;
  qaLoadingByPaper: Record<string, boolean>;
  setQALoadingForPaper: (paperId: string, loading: boolean) => void;

  exerciseByPaper: Record<string, DerivationExercise | null>;
  setExerciseForPaper: (paperId: string, e: DerivationExercise | null) => void;
  exerciseLoadingByPaper: Record<string, boolean>;
  setExerciseLoadingForPaper: (paperId: string, loading: boolean) => void;

  assumptionsByPaper: Record<string, Assumption[]>;
  setAssumptionsForPaper: (paperId: string, a: Assumption[]) => void;
  assumptionsLoadingByPaper: Record<string, boolean>;
  setAssumptionsLoadingForPaper: (paperId: string, loading: boolean) => void;
  assumptionsErrorByPaper: Record<string, string | null>;
  setAssumptionsError: (paperId: string, message: string | null) => void;

  searchResultsByPaper: Record<string, SearchResult[]>;
  setSearchResultsForPaper: (paperId: string, r: SearchResult[]) => void;
  searchLoadingByPaper: Record<string, boolean>;
  setSearchLoadingForPaper: (paperId: string, loading: boolean) => void;

  notesByPaper: Record<string, Note[]>;
  setNotesForPaper: (paperId: string, n: Note[]) => void;
  addNoteForPaper: (paperId: string, n: Note) => void;
  updateNoteForPaper: (paperId: string, id: string, text: string) => void;
  removeNoteForPaper: (paperId: string, id: string) => void;

  highlightsByPaper: Record<string, Highlight[]>;
  setHighlightsForPaper: (paperId: string, highlights: Highlight[]) => void;
  addHighlightForPaper: (paperId: string, highlight: Highlight) => void;
  removeHighlightForPaper: (paperId: string, id: string) => void;
  updateHighlightForPaper: (paperId: string, id: string, patch: Partial<Highlight>) => void;

  readingStateByPaper: Record<string, ReadingState | null>;
  setReadingStateForPaper: (paperId: string, state: ReadingState | null) => void;

  pendingPassageByPaper: Record<string, PendingPassage | null>;
  setPendingPassage: (paperId: string, passage: PendingPassage | null) => void;

  summaryByPaper: Record<string, PaperSummary | null>;
  setSummaryForPaper: (paperId: string, s: PaperSummary | null) => void;
  /**
   * In-flight partial summary keyed by paper id. Lite + deep phases
   * both merge into this map as they stream so the panel can render
   * incremental content for whichever phase is currently running.
   */
  summaryStreamingByPaper: Record<string, Partial<PaperSummary> | null>;
  setSummaryStreamingPartial: (paperId: string, partial: Partial<PaperSummary> | null) => void;
  clearSummaryStreamingPartial: (paperId: string) => void;
  summaryErrorByPaper: Record<string, string | null>;
  setSummaryError: (paperId: string, message: string | null) => void;
  summaryLoadingByPaper: Record<string, boolean>;
  setSummaryLoadingForPaper: (paperId: string, loading: boolean) => void;

  usageRefreshKey: number;
  bumpUsageRefresh: () => void;
}

export const useStore = create<AppStore>()(
  persist(
    (set, get) => ({
      paper: null,
      // When the active document id changes (new paper, upload handoff from
      // dashboard, library open, etc.), drop all analysis UI slices so we
      // never show paper B with paper A's summary/prepare state. The reader
      // page also calls resetAnalysisState on URL transitions; this path
      // catches every other setPaper entrypoint. Same-id updates (refetch,
      // folder change, figure re-extract) only replace `paper`.
      setPaper: (p) =>
        set((s) => {
          if (s.paper === p) return s;
          const prevId = s.paper?.id ?? null;
          const nextId = p?.id ?? null;
          if (prevId === nextId) {
            return { paper: p };
          }
          // Drop session-only overlays (pending blob, marquee mode) on
          // any active-paper change. Analysis slices live in per-paper
          // maps now — switching no longer wipes them, the panels just
          // read the new id's slot.
          return {
            paper: p,
            pendingFigureBlob: null,
            pendingFigureCaption: null,
            marqueeMode: false,
            questions: [],
          };
        }),

      activePaperId: null,
      setActivePaperId: (id) => set({ activePaperId: id }),

      papersById: {},
      // LRU cap: full ParsedPaper blobs (raw_text + cached_analysis) are large;
      // evict oldest non-active entries after 8 papers to keep long sessions responsive.
      cachePaper: (p) =>
        set((s) => {
          const next = { ...s.papersById, [p.id]: p };
          const keys = Object.keys(next);
          if (keys.length > 8) {
            const activeId = s.paper?.id;
            const evict = keys.find((k) => k !== activeId && k !== p.id);
            if (evict) delete next[evict];
          }
          return { papersById: next };
        }),
      updateCachedAnalysis: (paperId, partial) =>
        set((s) => {
          const existing = s.papersById[paperId];
          if (!existing) return s;
          return {
            papersById: {
              ...s.papersById,
              [paperId]: {
                ...existing,
                cached_analysis: {
                  ...(existing.cached_analysis || {}),
                  ...partial,
                },
              },
            },
            paper:
              s.paper?.id === paperId
                ? {
                    ...s.paper,
                    cached_analysis: {
                      ...(s.paper.cached_analysis || {}),
                      ...partial,
                    },
                  }
                : s.paper,
          };
        }),
      forgetCachedPaper: (paperId) =>
        set((s) => {
          const rest = { ...s.papersById };
          delete rest[paperId];
          return { papersById: rest };
        }),
      getCachedPaper: (id) => get().papersById[id],

      uiPrefs: {
        panelPos: "right",
        panelSizeSide: 400,
        panelSizeBottom: 300,
        hideQaSuggestions: false,
        scrollByPaper: {},
        qaDraftByPaper: {},
        relatedView: "graph",
      },
      setPanelPosition: (pos) =>
        set((s) => ({ uiPrefs: { ...s.uiPrefs, panelPos: pos } })),
      setPanelSize: (pos, size) =>
        set((s) => ({
          uiPrefs: {
            ...s.uiPrefs,
            ...(pos === "bottom" ? { panelSizeBottom: size } : { panelSizeSide: size }),
          },
        })),
      setHideQaSuggestions: (hidden) =>
        set((s) => ({ uiPrefs: { ...s.uiPrefs, hideQaSuggestions: hidden } })),
      setPdfScroll: (paperId, ratio) =>
        set((s) => ({
          uiPrefs: {
            ...s.uiPrefs,
            scrollByPaper: { ...s.uiPrefs.scrollByPaper, [paperId]: ratio },
          },
        })),
      setRelatedView: (view) =>
        set((s) => ({
          uiPrefs: { ...s.uiPrefs, relatedView: view },
        })),
      setQADraft: (paperId, draft) =>
        set((s) => {
          const prevMap = s.uiPrefs.qaDraftByPaper;
          const cur = prevMap[paperId];
          const trimmedNew = draft.trim();
          /** Bail out when unchanged — cloning `qaDraftByPaper` on every render caused Zustand churn (and QA panel effects re-firing unnecessarily). */
          if (trimmedNew === "") {
            if (cur === undefined) return s;
          } else if (cur === draft) {
            return s;
          }
          const qaDraftByPaper = { ...prevMap };
          if (trimmedNew) qaDraftByPaper[paperId] = draft;
          else delete qaDraftByPaper[paperId];
          return { uiPrefs: { ...s.uiPrefs, qaDraftByPaper } };
        }),
      clearPaperUiPrefs: (paperId) =>
        set((s) => {
          const scrollByPaper = { ...s.uiPrefs.scrollByPaper };
          const qaDraftByPaper = { ...s.uiPrefs.qaDraftByPaper };
          delete scrollByPaper[paperId];
          delete qaDraftByPaper[paperId];
          return { uiPrefs: { ...s.uiPrefs, scrollByPaper, qaDraftByPaper } };
        }),

      figureReextractInFlight: {},
      setFigureReextractInFlight: (paperId, running) =>
        set((s) => {
          const next = { ...s.figureReextractInFlight };
          if (running) next[paperId] = true;
          else delete next[paperId];
          return { figureReextractInFlight: next };
        }),

      sessionPapers: [],
      addSessionPaper: (p) => {
        const s = get();
        if (s.sessionPapers.some((sp) => sp.id === p.id)) return true;
        if (s.sessionPapers.length >= MAX_SESSION_PAPERS) return false;
        set({ sessionPapers: [...s.sessionPapers, p] });
        return true;
      },
      removeSessionPaper: (id) =>
        set((s) => {
          const papersById = { ...s.papersById };
          const scrollByPaper = { ...s.uiPrefs.scrollByPaper };
          const qaDraftByPaper = { ...s.uiPrefs.qaDraftByPaper };
          delete papersById[id];
          delete scrollByPaper[id];
          delete qaDraftByPaper[id];
          return {
            sessionPapers: s.sessionPapers.filter((sp) => sp.id !== id),
            papersById,
            uiPrefs: { ...s.uiPrefs, scrollByPaper, qaDraftByPaper },
          };
        }),

      // Fan out a title change to every place a paper appears in the
      // store so an inline rename in the nav bar updates the session
      // tab, the cached copy, and the active paper simultaneously —
      // without waiting for a round-trip refetch.
      updatePaperTitle: (id, title) =>
        set((s) => {
          const cached = s.papersById[id];
          const nextPapersById = cached
            ? { ...s.papersById, [id]: { ...cached, title } }
            : s.papersById;
          const nextSessionPapers = s.sessionPapers.map((sp) =>
            sp.id === id ? { ...sp, title } : sp,
          );
          const nextPaper =
            s.paper && s.paper.id === id ? { ...s.paper, title } : s.paper;
          return {
            papersById: nextPapersById,
            sessionPapers: nextSessionPapers,
            paper: nextPaper,
          };
        }),
      clearSession: () => {
        set({
          sessionPapers: [], crossPaperResults: [],
          papersById: {},
          pendingFigureBlob: null,
          pendingFigureCaption: null,
          marqueeMode: false,
          pdfTextLayerEmptyByPaper: {},
          pdfRegionHighlightsByPaper: {},
          preReadingByPaper: {},
          preReadingLoadingByPaper: {},
          preReadingErrorByPaper: {},
          assumptionsByPaper: {},
          assumptionsLoadingByPaper: {},
          summaryByPaper: {},
          summaryStreamingByPaper: {},
          summaryErrorByPaper: {},
          summaryLoadingByPaper: {},
          notesByPaper: {},
          highlightsByPaper: {},
          readingStateByPaper: {},
          pendingPassageByPaper: {},
          selectionResultByPaper: {},
          selectionHistoryByPaper: {},
          selectionLoadingByPaper: {},
          qaResultsByPaper: {},
          qaLoadingByPaper: {},
          exerciseByPaper: {},
          exerciseLoadingByPaper: {},
          searchResultsByPaper: {},
          searchLoadingByPaper: {},
          questions: [],
          activePaperId: null,
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
      // `crossPaperResults` is intentionally NOT per-paper. The Cross-paper
      // tab shows the workspace's QA history across every active paper.
      // Membership-staleness is handled at render time via `asked_against`.
      addCrossPaperResults: (items) =>
        set((s) => ({ crossPaperResults: [...items, ...s.crossPaperResults].slice(0, 80) })),
      clearCrossPaperResults: () => set({ crossPaperResults: [] }),

      loading: false,
      setLoading: (l) => set({ loading: l }),

      activeTab: "summary",
      setActiveTab: (t) => set((s) => (s.activeTab === t ? s : { activeTab: t })),

      marqueeMode: false,
      setMarqueeMode: (v) => set({ marqueeMode: v }),

      pdfTextLayerEmptyByPaper: {},
      setPdfTextLayerEmpty: (paperId, empty) =>
        set((s) => ({
          pdfTextLayerEmptyByPaper: empty
            ? { ...s.pdfTextLayerEmptyByPaper, [paperId]: true }
            : (() => {
                const next = { ...s.pdfTextLayerEmptyByPaper };
                delete next[paperId];
                return next;
              })(),
        })),

      pdfRegionHighlightsByPaper: {},
      addPdfRegionHighlight: (paperId, highlight) =>
        set((s) => {
          const prev = s.pdfRegionHighlightsByPaper[paperId] ?? [];
          const id = `region-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          return {
            pdfRegionHighlightsByPaper: {
              ...s.pdfRegionHighlightsByPaper,
              [paperId]: [...prev, { ...highlight, id }],
            },
          };
        }),

      pendingFigureBlob: null,
      setPendingFigureBlob: (b) => set({ pendingFigureBlob: b }),
      pendingFigureCaption: null,
      setPendingFigureCaption: (caption) => set({ pendingFigureCaption: caption }),

      panelVisible: true,
      setPanelVisible: (v) => set({ panelVisible: v }),
      togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

      headerHidden: false,
      setHeaderHidden: (v) => set({ headerHidden: v }),
      toggleHeader: () => set((s) => ({ headerHidden: !s.headerHidden })),
      focusMode: false,
      setFocusMode: (v) => set((s) => (s.focusMode === v ? s : { focusMode: v })),
      toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),

      analysisFontScale: 1,
      setAnalysisFontScale: (v) =>
        set({ analysisFontScale: Math.max(0.85, Math.min(1.6, v)) }),
      bumpAnalysisFontScale: (delta) =>
        set((s) => ({
          analysisFontScale: Math.max(0.85, Math.min(1.6, +(s.analysisFontScale + delta).toFixed(2))),
        })),

      analysisFontFamily: "sans",
      setAnalysisFontFamily: (v) => set({ analysisFontFamily: v }),

      selectionResultByPaper: {},
      setSelectionResultForPaper: (paperId, r) =>
        set((state) => {
          const cur = state.selectionResultByPaper[paperId] ?? null;
          if (cur === r) return state;
          if (cur && r && selectionRowsEqual(cur, r)) return state;
          return {
            selectionResultByPaper: {
              ...state.selectionResultByPaper,
              [paperId]: r,
            },
          };
        }),
      selectionLoadingByPaper: {},
      setSelectionLoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.selectionLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { selectionLoadingByPaper: next };
        }),
      selectionHistoryByPaper: {},
      upsertSelectionInHistoryForPaper: (paperId, r) =>
        set((state) => {
          const list = state.selectionHistoryByPaper[paperId] ?? EMPTY_SELECTION_LIST;
          if (r.clientKey) {
            const idx = list.findIndex((h) => h.clientKey === r.clientKey);
            if (idx >= 0) {
              const merged = { ...list[idx], ...r };
              if (selectionRowsEqual(list[idx], merged)) return state;
              const next = [...list];
              next[idx] = merged;
              return {
                selectionHistoryByPaper: {
                  ...state.selectionHistoryByPaper,
                  [paperId]: next,
                },
              };
            }
          }
          return {
            selectionHistoryByPaper: {
              ...state.selectionHistoryByPaper,
              [paperId]: [r, ...list].slice(0, 30),
            },
          };
        }),
      openSelectionFromHistory: (paperId, r) =>
        set((state) => ({
          selectionResultByPaper: {
            ...state.selectionResultByPaper,
            [paperId]: r,
          },
          activeTab: "selection",
          panelVisible: true,
        })),
      removeSelectionFromHistoryForPaper: (paperId, r) =>
        set((state) => {
          const target = selectionResultKey(r);
          const list = state.selectionHistoryByPaper[paperId] ?? [];
          const next = list.filter((h) => selectionResultKey(h) !== target);
          const cur = state.selectionResultByPaper[paperId] ?? null;
          const clearCurrent = cur && selectionResultKey(cur) === target;
          return {
            selectionHistoryByPaper: {
              ...state.selectionHistoryByPaper,
              [paperId]: next,
            },
            selectionResultByPaper: clearCurrent
              ? { ...state.selectionResultByPaper, [paperId]: null }
              : state.selectionResultByPaper,
          };
        }),

      preReadingByPaper: {},
      setPreReadingForPaper: (paperId, preReading) =>
        set((state) => ({
          preReadingByPaper: {
            ...state.preReadingByPaper,
            [paperId]: preReading,
          },
        })),
      preReadingLoadingByPaper: {},
      setPreReadingLoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.preReadingLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { preReadingLoadingByPaper: next };
        }),
      preReadingErrorByPaper: {},
      setPreReadingError: (paperId, message) =>
        set((state) => ({
          preReadingErrorByPaper: {
            ...state.preReadingErrorByPaper,
            [paperId]: message,
          },
        })),

      questions: [],
      addQuestion: (q) => set((s) => ({ questions: [...s.questions, q] })),
      removeQuestion: (idx) =>
        set((s) => ({ questions: s.questions.filter((_, i) => i !== idx) })),
      clearQuestions: () => set({ questions: [] }),
      qaResultsByPaper: {},
      // Cap QA history to the most recent 60 items per paper.
      setQAResultsForPaper: (paperId, items) =>
        set((state) => ({
          qaResultsByPaper: {
            ...state.qaResultsByPaper,
            [paperId]: items.slice(-60),
          },
        })),
      qaLoadingByPaper: {},
      setQALoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.qaLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { qaLoadingByPaper: next };
        }),

      exerciseByPaper: {},
      setExerciseForPaper: (paperId, e) =>
        set((state) => ({
          exerciseByPaper: { ...state.exerciseByPaper, [paperId]: e },
        })),
      exerciseLoadingByPaper: {},
      setExerciseLoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.exerciseLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { exerciseLoadingByPaper: next };
        }),

      assumptionsByPaper: {},
      setAssumptionsForPaper: (paperId, a) =>
        set((state) => {
          const prev = state.assumptionsByPaper[paperId];
          if (
            prev === a ||
            (prev &&
              a &&
              prev.length === a.length &&
              JSON.stringify(prev) === JSON.stringify(a))
          ) {
            return state;
          }
          return {
            assumptionsByPaper: { ...state.assumptionsByPaper, [paperId]: a },
          };
        }),
      assumptionsLoadingByPaper: {},
      setAssumptionsLoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.assumptionsLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { assumptionsLoadingByPaper: next };
        }),
      assumptionsErrorByPaper: {},
      setAssumptionsError: (paperId, message) =>
        set((state) => ({
          assumptionsErrorByPaper: {
            ...state.assumptionsErrorByPaper,
            [paperId]: message,
          },
        })),

      searchResultsByPaper: {},
      setSearchResultsForPaper: (paperId, r) =>
        set((state) => ({
          searchResultsByPaper: {
            ...state.searchResultsByPaper,
            [paperId]: r,
          },
        })),
      searchLoadingByPaper: {},
      setSearchLoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.searchLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { searchLoadingByPaper: next };
        }),

      notesByPaper: {},
      setNotesForPaper: (paperId, n) =>
        set((state) => ({
          notesByPaper: { ...state.notesByPaper, [paperId]: n },
        })),
      addNoteForPaper: (paperId, n) =>
        set((state) => ({
          notesByPaper: {
            ...state.notesByPaper,
            [paperId]: [...(state.notesByPaper[paperId] ?? []), n],
          },
        })),
      updateNoteForPaper: (paperId, id, text) =>
        set((state) => {
          const list = state.notesByPaper[paperId] ?? [];
          return {
            notesByPaper: {
              ...state.notesByPaper,
              [paperId]: list.map((note) =>
                note.id === id ? { ...note, text } : note,
              ),
            },
          };
        }),
      removeNoteForPaper: (paperId, id) =>
        set((state) => {
          const list = state.notesByPaper[paperId] ?? [];
          return {
            notesByPaper: {
              ...state.notesByPaper,
              [paperId]: list.filter((note) => note.id !== id),
            },
          };
        }),

      highlightsByPaper: {},
      setHighlightsForPaper: (paperId, highlights) =>
        set((state) => ({
          highlightsByPaper: { ...state.highlightsByPaper, [paperId]: highlights },
        })),
      addHighlightForPaper: (paperId, highlight) =>
        set((state) => ({
          highlightsByPaper: {
            ...state.highlightsByPaper,
            [paperId]: [highlight, ...(state.highlightsByPaper[paperId] ?? [])],
          },
        })),
      removeHighlightForPaper: (paperId, id) =>
        set((state) => ({
          highlightsByPaper: {
            ...state.highlightsByPaper,
            [paperId]: (state.highlightsByPaper[paperId] ?? []).filter((h) => h.id !== id),
          },
        })),
      updateHighlightForPaper: (paperId, id, patch) =>
        set((state) => ({
          highlightsByPaper: {
            ...state.highlightsByPaper,
            [paperId]: (state.highlightsByPaper[paperId] ?? []).map((h) =>
              h.id === id ? { ...h, ...patch } : h,
            ),
          },
        })),

      readingStateByPaper: {},
      setReadingStateForPaper: (paperId, state) =>
        set((s) => ({
          readingStateByPaper: { ...s.readingStateByPaper, [paperId]: state },
        })),

      pendingPassageByPaper: {},
      setPendingPassage: (paperId, passage) =>
        set((s) => ({
          pendingPassageByPaper: { ...s.pendingPassageByPaper, [paperId]: passage },
        })),

      summaryByPaper: {},
      setSummaryForPaper: (paperId, summary) =>
        set((state) => {
          const cur = state.summaryByPaper[paperId] ?? null;
          if (cur === summary) return state;
          if (cur && summary && JSON.stringify(cur) === JSON.stringify(summary)) {
            return state;
          }
          return {
            summaryByPaper: { ...state.summaryByPaper, [paperId]: summary },
          };
        }),
      summaryStreamingByPaper: {},
      setSummaryStreamingPartial: (paperId, partial) =>
        set((state) => ({
          summaryStreamingByPaper: {
            ...state.summaryStreamingByPaper,
            [paperId]: partial,
          },
        })),
      clearSummaryStreamingPartial: (paperId) =>
        set((state) => {
          const next = { ...state.summaryStreamingByPaper };
          delete next[paperId];
          return { summaryStreamingByPaper: next };
        }),
      summaryErrorByPaper: {},
      setSummaryError: (paperId, message) =>
        set((state) => ({
          summaryErrorByPaper: {
            ...state.summaryErrorByPaper,
            [paperId]: message,
          },
        })),
      summaryLoadingByPaper: {},
      setSummaryLoadingForPaper: (paperId, loading) =>
        set((state) => {
          const next = { ...state.summaryLoadingByPaper };
          if (loading) next[paperId] = true;
          else delete next[paperId];
          return { summaryLoadingByPaper: next };
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
      // Per audit §3.3: keep only lightweight session/UI state in
      // localStorage. Analysis artifacts live in server cached_analysis and
      // in the in-memory papersById read-through cache.
      // `marqueeMode` / `pendingFigureBlob` intentionally omitted —
      // session-only overlays and blob hand-offs.
      partialize: (state) => ({
        sessionPapers: state.sessionPapers,
        activePaperId: state.activePaperId,
        // Cross-paper QA history (capped at 80 items in addCrossPaperResults).
        crossPaperResults: state.crossPaperResults,
        // TODO(backend): sync region highlights via cached_analysis.region_highlights.
        pdfRegionHighlightsByPaper: state.pdfRegionHighlightsByPaper,
        // Chrome preferences survive reloads so the reader feels "sticky":
        // if the user worked in focus mode last session, they return to it
        // instead of re-picking it every time. Intentionally excludes
        // `panelVisible` (already persisted elsewhere in this store).
        headerHidden: state.headerHidden,
        focusMode: state.focusMode,
        analysisFontScale: state.analysisFontScale,
        analysisFontFamily: state.analysisFontFamily,
        uiPrefs: state.uiPrefs,
      }),
      migrate: (persisted) => {
        const p = persisted as {
          state?: { pdfRegionHighlightsByPaper?: Record<string, Array<Record<string, unknown>>> };
        };
        const byPaper = p.state?.pdfRegionHighlightsByPaper;
        if (byPaper) {
          for (const pid of Object.keys(byPaper)) {
            byPaper[pid] = (byPaper[pid] ?? []).filter(
              (h) =>
                typeof h.xPct === "number" &&
                typeof h.yPct === "number" &&
                typeof h.wPct === "number" &&
                typeof h.hPct === "number",
            );
          }
        }
        return persisted;
      },
    }
  )
);
