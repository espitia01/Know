"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { api, type SelectionAnalysisResult, type PaperListEntry } from "@/lib/api";
import { useStore } from "@/lib/store";
import { SelectionToolbar, type SelectionAction } from "@/components/pdf/SelectionToolbar";
import { AnalysisPanel, type PanelPosition } from "@/components/panel/BottomPanel";
import { BibtexModal } from "@/components/BibtexModal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import {
  autoAnalyzedPapers,
  hasActiveRequest,
  markRequestStart,
  markRequestEnd,
  clearProgressStart,
  forgetPaper,
} from "@/lib/analysisState";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const PdfViewer = dynamic(
  () => import("@/components/pdf/PdfViewer").then((m) => m.PdfViewer),
  {
    ssr: false,
      loading: () => (
      <div className="flex items-center justify-center h-full bg-background">
        <div className="w-5 h-5 border-2 border-border border-t-foreground rounded-full animate-spin" />
      </div>
    ),
  }
);

const MIN_SIDE = 280;
const MAX_SIDE = 700;
const DEFAULT_SIDE = 400;
const MIN_BOTTOM = 180;
const MAX_BOTTOM = 500;
const DEFAULT_BOTTOM = 300;

const POSITIONS: PanelPosition[] = ["right", "bottom", "left"];

const PANEL_POS_KEY = "know-panel-pos";
const PANEL_SIZE_SIDE_KEY = "know-panel-size-side";
const PANEL_SIZE_BOTTOM_KEY = "know-panel-size-bottom";

function readStoredPos(): PanelPosition {
  if (typeof window === "undefined") return "right";
  const v = window.localStorage.getItem(PANEL_POS_KEY);
  if (v === "right" || v === "left" || v === "bottom") return v;
  return "right";
}

function readStoredSize(pos: PanelPosition): number {
  if (typeof window === "undefined") return pos === "bottom" ? DEFAULT_BOTTOM : DEFAULT_SIDE;
  const key = pos === "bottom" ? PANEL_SIZE_BOTTOM_KEY : PANEL_SIZE_SIDE_KEY;
  const v = window.localStorage.getItem(key);
  if (v) {
    const n = parseInt(v, 10);
    if (!isNaN(n)) {
      if (pos === "bottom") return Math.min(MAX_BOTTOM, Math.max(MIN_BOTTOM, n));
      return Math.min(MAX_SIDE, Math.max(MIN_SIDE, n));
    }
  }
  return pos === "bottom" ? DEFAULT_BOTTOM : DEFAULT_SIDE;
}

function AddPaperPopover({
  sessionIds,
  onAdd,
  onClose,
}: {
  sessionIds: Set<string>;
  onAdd: (id: string, title: string) => void;
  onClose: () => void;
}) {
  const [papers, setPapers] = useState<PaperListEntry[]>([]);
  const [loadingPapers, setLoadingPapers] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listPapers().then((p) => { setPapers(p); setLoadingPapers(false); }).catch(() => setLoadingPapers(false));
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const handleUpload = useCallback(async (file: File) => {
    setUploadError(null);
    // Client-side guardrail: the backend also enforces this, but checking
    // here avoids a doomed upload of a 100MB PDF over slow connections.
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(
        `PDF is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB.`
      );
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("Only PDF files are supported.");
      return;
    }
    setUploading(true);
    try {
      const paper = await api.uploadPaper(file);
      onAdd(paper.id, paper.title);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }, [onAdd]);

  const folders = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => { if (p.folder) set.add(p.folder); });
    return ["Unfiled", ...Array.from(set).sort()];
  }, [papers]);

  const folderPapers = useMemo(() => {
    if (selectedFolder === null) return [];
    if (selectedFolder === "Unfiled") return papers.filter((p) => !p.folder);
    return papers.filter((p) => p.folder === selectedFolder);
  }, [papers, selectedFolder]);

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 z-50 glass-strong rounded-2xl shadow-xl w-80 max-h-[420px] flex flex-col animate-fade-in overflow-hidden"
    >
      {/* Upload section */}
      <div className="p-2.5 border-b border-border space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 text-[12px] font-semibold px-3 py-2.5 rounded-xl btn-primary-glass text-white transition-all disabled:opacity-50"
        >
          {uploading ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Uploading...
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              Upload New Paper
            </>
          )}
        </button>
        {uploadError && (
          <p role="alert" className="text-[11px] text-destructive leading-snug px-1">
            {uploadError}
          </p>
        )}
      </div>

      <div className="overflow-y-auto flex-1">
        {loadingPapers ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-border border-t-foreground rounded-full animate-spin" />
          </div>
        ) : selectedFolder === null ? (
          /* Folder list */
          <div className="p-1.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground/80 px-2.5 py-1.5">
              Select a folder
            </p>
            {folders.map((f) => {
              const count = f === "Unfiled"
                ? papers.filter((p) => !p.folder).length
                : papers.filter((p) => p.folder === f).length;
              return (
                <button
                  key={f}
                  onClick={() => setSelectedFolder(f)}
                  className="w-full text-left flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 hover:bg-accent/60 transition-colors group"
                >
                  <svg className="w-4 h-4 text-muted-foreground/60 group-hover:text-muted-foreground transition-colors shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  <span className="text-[12px] font-medium text-foreground/90 flex-1 truncate">{f}</span>
                  <span className="text-[10px] text-muted-foreground/80 tabular-nums">{count}</span>
                  <svg className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </button>
              );
            })}
          </div>
        ) : (
          /* Papers in selected folder */
          <div className="p-1.5">
            <button
              onClick={() => setSelectedFolder(null)}
              className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80 hover:text-foreground/90 transition-colors px-2 py-1.5 mb-0.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              {selectedFolder}
            </button>
            {folderPapers.length === 0 ? (
              <p className="text-[12px] text-muted-foreground/80 text-center py-6">No papers in this folder</p>
            ) : (
              folderPapers.map((p) => {
                const inSession = sessionIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => { if (!inSession) onAdd(p.id, p.title); }}
                    disabled={inSession}
                    className={`w-full text-left rounded-lg px-2.5 py-2.5 transition-colors ${
                      inSession
                        ? "opacity-40 cursor-default"
                        : "hover:bg-accent/60 cursor-pointer"
                    }`}
                  >
                    <p className="text-[12px] font-medium text-foreground truncate leading-tight">
                      {p.title}
                    </p>
                    <p className="text-[10px] text-muted-foreground/80 truncate mt-0.5">
                      {(p.authors || []).slice(0, 2).join(", ")}
                      {(p.authors || []).length > 2 ? " et al." : ""}
                      {inSession && " · In session"}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PaperContent() {
  const params = useParams();
  const router = useRouter();
  const { user: tierUser, loading: tierLoading } = useUserTier();
  const isFree = tierLoading ? true : (!tierUser || tierUser.tier === "free");
  // Multi-paper sessions + workspaces are only useful alongside cross-paper
  // Q&A. Gate them on the same `multi-qa` feature so Scholar users don't
  // open a session they can't meaningfully use.
  const canMultiPaper = !tierLoading && !!tierUser && canAccess(tierUser.tier, "multi-qa");
  const paperId = params.id as string;
  const {
    paper, setPaper, loading, setLoading,
    panelVisible, setPanelVisible, togglePanel,
    setPreReading, setPreReadingLoading,
    setAssumptions, setAssumptionsLoading,
    setNotes,
    selectionResult,
    setSelectionResult, setSelectionLoading, addSelectionToHistory,
    setActiveTab,
    setSummary, setSummaryLoading,
    cachePaper,
    sessionPapers, addSessionPaper, removeSessionPaper, clearSession,
    savePaperCache, restorePaperCache,
    crossPaperResults, addCrossPaperResults, clearCrossPaperResults,
    resetAnalysisState,
  } = useStore();
  const [error, setError] = useState("");

  const [activePaperId, setActivePaperId] = useState(paperId);
  const sseAbortRef = useRef<AbortController | null>(null);
  const initialLoadDone = useRef(false);

  useEffect(() => {
    if (paperId !== activePaperId) {
      sseAbortRef.current?.abort();
      savePaperCache(activePaperId);
      const restored = restorePaperCache(paperId);
      if (!restored) resetAnalysisState();
      // If a background fetch for the incoming paper is still in flight,
      // re-show its loading state so the UI doesn't flash "Analyze Paper".
      if (hasActiveRequest(paperId, "preReading")) setPreReadingLoading(true);
      if (hasActiveRequest(paperId, "assumptions")) setAssumptionsLoading(true);
      if (hasActiveRequest(paperId, "summary")) setSummaryLoading(true);
      setActivePaperId(paperId);
    }
  }, [paperId]);
  const [panelPos, setPanelPos] = useState<PanelPosition>(() => readStoredPos());
  const [panelSize, setPanelSize] = useState(() => readStoredSize(readStoredPos()));
  const dragging = useRef(false);
  const startCoord = useRef(0);
  const startSize = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PANEL_POS_KEY, panelPos);
  }, [panelPos]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = panelPos === "bottom" ? PANEL_SIZE_BOTTOM_KEY : PANEL_SIZE_SIDE_KEY;
    window.localStorage.setItem(key, String(panelSize));
  }, [panelPos, panelSize]);

  const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [folderInput, setFolderInput] = useState("");
  const [showAddPaper, setShowAddPaper] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [savedWorkspaces, setSavedWorkspaces] = useState<{ id: string; name: string; paper_ids: string[]; cross_paper_results: { question: string; answer: string }[]; updated_at: string }[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string | null>(null);

  const sessionIds = useMemo(() => new Set(sessionPapers.map((p) => p.id)), [sessionPapers]);

  useEffect(() => {
    api.listPapers().then((papers) => {
      const folders = [...new Set(papers.map((p) => p.folder).filter(Boolean))].sort();
      setAllFolders(folders);
    }).catch(() => {});
  }, []);

  // Register the URL paper as the first session paper
  useEffect(() => {
    if (paper && paper.id === paperId) {
      addSessionPaper({ id: paper.id, title: paper.title });
    }
  }, [paper, paperId, addSessionPaper]);

  const handleMoveToFolder = useCallback(async (folder: string) => {
    if (!paper) return;
    try {
      await api.updateFolder(paper.id, folder);
      setPaper({ ...paper, folder });
    } catch (e) { console.error(e); }
    setShowFolderPicker(false);
    setFolderInput("");
  }, [paper, setPaper]);

  const handleCreateAndMoveToFolder = useCallback(async () => {
    const name = folderInput.trim();
    if (!name || !paper) return;
    try {
      await api.updateFolder(paper.id, name);
      setPaper({ ...paper, folder: name });
      if (!allFolders.includes(name)) setAllFolders((prev) => [...prev, name].sort());
    } catch (e) { console.error(e); }
    setShowFolderPicker(false);
    setFolderInput("");
  }, [folderInput, paper, setPaper, allFolders]);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!showAddPaper && !showFolderPicker && !showWorkspaceMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-dropdown]")) {
        setShowAddPaper(false);
        setShowFolderPicker(false);
        setShowWorkspaceMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAddPaper, showFolderPicker, showWorkspaceMenu]);

  // Save cache on unmount (navigating away from paper page entirely)
  useEffect(() => {
    const saveOnUnload = () => {
      const s = useStore.getState();
      s.savePaperCache(activePaperId);
    };
    window.addEventListener("beforeunload", saveOnUnload);
    return () => {
      window.removeEventListener("beforeunload", saveOnUnload);
      saveOnUnload();
    };
  }, [activePaperId]);

  // `paperCaches` is an in-memory-only fast-switch cache. It is NOT
  // persisted (see the store's `partialize`), so on a full-page reload
  // every analysis field starts empty and must be re-hydrated from the
  // server via `paper.cached_analysis` in the effect below. We keep the
  // in-session cache so flipping between open papers stays snappy.
  const initialRestoreDoneRef = useRef(false);
  useEffect(() => {
    if (initialRestoreDoneRef.current) return;
    initialRestoreDoneRef.current = true;
    const store = useStore.getState();
    if (store.paperCaches[activePaperId]) {
      const ok = store.restorePaperCache(activePaperId);
      if (ok) {
        // Re-apply loading flags for any in-flight background requests
        // for this paper (restorePaperCache resets them to false).
        if (hasActiveRequest(activePaperId, "preReading")) setPreReadingLoading(true);
        if (hasActiveRequest(activePaperId, "assumptions")) setAssumptionsLoading(true);
        if (hasActiveRequest(activePaperId, "summary")) setSummaryLoading(true);
      }
    }
  }, [activePaperId, setPreReadingLoading, setAssumptionsLoading, setSummaryLoading]);

  useEffect(() => {
    let stale = false;
    setError("");

    // If we have a cached ParsedPaper, show it immediately — avoids the full-page
    // spinner during paper switches. We still refetch in the background to pick up
    // fresh folder/tag updates.
    const cached = useStore.getState().papersById[activePaperId];
    if (cached) {
      setPaper(cached);
      initialLoadDone.current = true;
      setLoading(false);
    } else if (!initialLoadDone.current) {
      setLoading(true);
    }

    api
      .getPaper(activePaperId)
      .then((p) => {
        if (stale) return;
        setPaper(p);
        cachePaper(p);
        initialLoadDone.current = true;
      })
      .catch((e) => {
        if (!stale && !cached) setError(e.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => { stale = true; };
  }, [activePaperId, setPaper, setLoading, cachePaper]);

  // Hydrate the analysis pane from the freshly loaded paper.
  //
  // The server (`paper.cached_analysis`) is the source of truth for every
  // artifact — pre-reading, assumptions, summary, selection history, QA
  // history. The frontend local cache is a fast-switch hint only, never a
  // replacement for server data.
  //
  // We re-run this effect every time `paper.id` becomes `activePaperId`
  // (i.e. on mount and on paper switch). Previously we short-circuited
  // when a "local cache was restored" signal was set, which left the pane
  // stuck showing a partial snapshot (e.g. selection history empty) and
  // gave the user no way to retry because `autoAnalyzedPapers` blocked
  // re-entry.
  useEffect(() => {
    if (!paper || paper.id !== activePaperId) return;
    if (tierLoading) return;

    const pid = activePaperId;
    const cache = paper.cached_analysis || {};

    if (paper.notes) setNotes(paper.notes);

    // Selection history: always mirror the server list. Previously this
    // only ran once per session and only if the store was empty, so a
    // "Derive" performed before the last reload was invisible on return.
    if (Array.isArray(cache.selections)) {
      const store = useStore.getState();
      const serverSelections = cache.selections as SelectionAnalysisResult[];
      const merged = [...serverSelections].reverse();
      // Reverse so the newest-first ordering matches what addSelectionToHistory
      // produces at runtime. Replace wholesale — server has every selection.
      if (JSON.stringify(store.selectionHistory) !== JSON.stringify(merged)) {
        useStore.setState({ selectionHistory: merged.slice(0, 50) });
      }
      // On a fresh mount (e.g. after refresh), surface the most recent
      // selection as the "current" result so the Selections tab isn't
      // just an empty collapsed history list. We only do this when the
      // store has no active result — mid-stream or fresh selections take
      // precedence.
      if (!store.selectionResult && !store.selectionLoading && merged.length > 0) {
        useStore.setState({ selectionResult: merged[0] });
      }
    }

    // Pre-reading: prefer the server cache; otherwise kick off a fresh
    // analysis for users with the "prepare" feature.
    // Note: per-field hydration below deliberately avoids "else: setXxx(null)"
    // branches. The effect re-runs whenever `paper` changes (e.g. a
    // background refetch lands), and a blanket clear would race with
    // in-flight analyses — we'd setPreReading(null) on re-entry while the
    // api.analyze call was still running, then when it resolves the
    // result can be invisible if another re-run happens between. Paper
    // switches handle cross-paper bleed via resetAnalysisState() in
    // handleSwitchPaper / URL-change effect.
    if (cache.pre_reading) {
      setPreReading(cache.pre_reading);
    } else if (
      canAccess(tierUser?.tier || "free", "prepare") &&
      !hasActiveRequest(pid, "preReading") &&
      !autoAnalyzedPapers.has(`${pid}:preReading`)
    ) {
      autoAnalyzedPapers.add(`${pid}:preReading`);
      markRequestStart(pid, "preReading");
      setPreReadingLoading(true);
      api.analyze(pid)
        .then((r) => {
          const s = useStore.getState();
          if (s.paper?.id === pid) setPreReading(r);
        })
        .catch(() => {})
        .finally(() => {
          markRequestEnd(pid, "preReading");
          clearProgressStart(pid, "preReading");
          if (useStore.getState().paper?.id === pid) {
            setPreReadingLoading(false);
          }
        });
    }

    if (cache.assumptions) {
      setAssumptions(cache.assumptions.assumptions || []);
    } else if (
      canAccess(tierUser?.tier || "free", "assumptions") &&
      !hasActiveRequest(pid, "assumptions") &&
      !autoAnalyzedPapers.has(`${pid}:assumptions`)
    ) {
      autoAnalyzedPapers.add(`${pid}:assumptions`);
      markRequestStart(pid, "assumptions");
      setAssumptionsLoading(true);
      api.getAssumptions(pid)
        .then((r) => {
          const s = useStore.getState();
          if (s.paper?.id === pid) setAssumptions(r.assumptions);
        })
        .catch(() => {})
        .finally(() => {
          markRequestEnd(pid, "assumptions");
          clearProgressStart(pid, "assumptions");
          if (useStore.getState().paper?.id === pid) {
            setAssumptionsLoading(false);
          }
        });
    }

    if (cache.summary) {
      setSummary(cache.summary);
    }

    if (cache.qa_sessions && cache.qa_sessions.length > 0) {
      const allItems = cache.qa_sessions.flatMap(
        (session: { items?: { question: string; answer: string }[] }) => session.items || []
      );
      useStore.getState().setQAResults(allItems);
    }
  }, [paper, activePaperId, tierUser?.tier, tierLoading, setPreReading, setPreReadingLoading, setAssumptions, setAssumptionsLoading, setNotes, setSummary]);

  const handleSwitchPaper = useCallback((id: string) => {
    if (id === activePaperId) return;
    sseAbortRef.current?.abort();
    savePaperCache(activePaperId);
    setSelection(null);
    setSelectionResult(null);

    const restored = restorePaperCache(id);
    if (!restored) {
      resetAnalysisState();
    }
    if (hasActiveRequest(id, "preReading")) setPreReadingLoading(true);
    if (hasActiveRequest(id, "assumptions")) setAssumptionsLoading(true);
    if (hasActiveRequest(id, "summary")) setSummaryLoading(true);
    setActivePaperId(id);
    // Keep the URL in sync with the active paper so deep links, browser
    // history, and copy-URL all reflect reality. `router.replace` (not push)
    // avoids polluting history every time the user clicks a tab.
    if (typeof window !== "undefined" && id !== paperId) {
      router.replace(`/paper/${id}`);
    }
  }, [activePaperId, paperId, router, savePaperCache, restorePaperCache, resetAnalysisState, setPreReadingLoading, setAssumptionsLoading, setSummaryLoading]);

  const handleAddPaper = useCallback((id: string, title: string) => {
    addSessionPaper({ id, title });
    setShowAddPaper(false);
  }, [addSessionPaper]);

  const handleRemoveSessionPaper = useCallback((id: string) => {
    if (sessionPapers.length <= 1) return;
    removeSessionPaper(id);
    forgetPaper(id);
    if (id === activePaperId) {
      const remaining = sessionPapers.filter((p) => p.id !== id);
      if (remaining.length > 0) {
        handleSwitchPaper(remaining[0].id);
      }
    }
  }, [sessionPapers, activePaperId, removeSessionPaper, handleSwitchPaper]);

  const handleSaveWorkspace = useCallback(async () => {
    const name = workspaceNameInput.trim() || `Session · ${sessionPapers.length} papers`;
    setWorkspaceSaving(true);
    setWorkspaceSaved(false);
    try {
      savePaperCache(activePaperId);
      await api.saveWorkspace({
        name,
        paper_ids: sessionPapers.map((p) => p.id),
        cross_paper_results: crossPaperResults,
      });
      setWorkspaceNameInput("");
      setActiveWorkspaceName(name);
      setWorkspaceSaved(true);
      setTimeout(() => setWorkspaceSaved(false), 2000);
      try {
        const wsList = await api.listWorkspaces();
        setSavedWorkspaces(wsList);
        setWorkspacesLoaded(true);
      } catch { /* ignore */ }
    } catch (e) {
      console.error("Failed to save workspace:", e);
    } finally {
      setWorkspaceSaving(false);
    }
  }, [workspaceNameInput, sessionPapers, crossPaperResults, activePaperId, savePaperCache]);

  const handleLoadWorkspace = useCallback(async (ws: typeof savedWorkspaces[0]) => {
    // Fetch papers BEFORE mutating state so we don't leave the user on a
    // blank session if every paper in the workspace has since been deleted.
    const loaded: { id: string; title: string }[] = [];
    const missing: string[] = [];
    for (const pid of ws.paper_ids) {
      try {
        const p = await api.getPaper(pid);
        loaded.push({ id: p.id, title: p.title });
      } catch {
        missing.push(pid);
      }
    }

    if (loaded.length === 0) {
      setError(
        "This workspace can't be opened — every paper it references has been deleted."
      );
      setShowWorkspaceMenu(false);
      return;
    }

    clearSession();
    clearCrossPaperResults();

    if (ws.cross_paper_results && ws.cross_paper_results.length > 0) {
      addCrossPaperResults(ws.cross_paper_results);
    }
    for (const p of loaded) addSessionPaper(p);

    const firstId = loaded[0].id;
    setActivePaperId(firstId);
    if (firstId !== paperId) {
      router.push(`/paper/${firstId}`);
    }
    setShowWorkspaceMenu(false);
    setActiveWorkspaceName(
      missing.length > 0 ? `${ws.name} (${missing.length} missing)` : ws.name
    );
  }, [clearSession, clearCrossPaperResults, addCrossPaperResults, addSessionPaper, paperId, router]);

  const handleOpenWorkspaceMenu = useCallback(async () => {
    const opening = !showWorkspaceMenu;
    setShowAddPaper(false);
    setShowFolderPicker(false);
    setShowWorkspaceMenu((v) => !v);
    if (opening) {
      try {
        const wsList = await api.listWorkspaces();
        setSavedWorkspaces(wsList);
        setWorkspacesLoaded(true);
      } catch {
        // ignore
      }
    }
  }, [showWorkspaceMenu]);

  const handleDeleteWorkspace = useCallback(async (wsId: string) => {
    const ws = savedWorkspaces.find((w) => w.id === wsId);
    const name = ws?.name || "this workspace";
    if (typeof window !== "undefined") {
      const ok = window.confirm(`Delete "${name}"? This cannot be undone.`);
      if (!ok) return;
    }
    try {
      await api.deleteWorkspace(wsId);
      setSavedWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
    } catch (e) {
      console.error("Failed to delete workspace:", e);
    }
  }, [savedWorkspaces]);

  const [bibtexModal, setBibtexModal] = useState<{
    open: boolean;
    paperIds?: string[];
    workspaceId?: string;
    label?: string;
  }>({ open: false });

  const handleExportBibtex = useCallback((opts: { paper_ids?: string[]; workspace_id?: string }, label?: string) => {
    setBibtexModal({
      open: true,
      paperIds: opts.paper_ids,
      workspaceId: opts.workspace_id,
      label: label || "Current paper",
    });
  }, []);

  const [paperUsage, setPaperUsage] = useState<{
    qa_used: number; qa_limit: number; selections_used: number; selections_limit: number;
  } | null>(null);

  const usageRefreshKey = useStore((s) => s.usageRefreshKey);

  const refreshUsage = useCallback(() => {
    api.getPaperUsage(activePaperId).then(setPaperUsage).catch(() => {});
  }, [activePaperId]);

  useEffect(() => { refreshUsage(); }, [refreshUsage, usageRefreshKey]);

  const handleTextSelected = useCallback((text: string, rect: DOMRect) => {
    setSelection({ text, rect });
  }, []);

  const handleSelectionClear = useCallback(() => {
    setSelection(null);
  }, []);

  const handleSelectionAction = useCallback(async (action: SelectionAction, text: string) => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();

    // Capture the paper this action was started for. Every state write
    // below must verify the user is still viewing this paper — otherwise
    // a slow "Derive" on paper A could repaint the analysis pane for
    // paper B once the user switches.
    const startedFor = activePaperId;
    const stillOnStartedPaper = () =>
      useStore.getState().paper?.id === startedFor;

    if (action === "note") {
      setPanelVisible(true);
      setActiveTab("notes");
      try {
        const note = await api.addNote(startedFor, text, "PDF Selection");
        if (stillOnStartedPaper()) {
          useStore.getState().addNote(note);
        }
      } catch (e) {
        console.error("Failed to save note:", e);
      }
      return;
    }

    sseAbortRef.current?.abort();
    const controller = new AbortController();
    sseAbortRef.current = controller;

    setPanelVisible(true);
    setActiveTab("selection");
    setSelectionLoading(true);
    setSelectionResult(null);

    const guardedSetSelectionResult = (r: SelectionAnalysisResult | null) => {
      if (!stillOnStartedPaper()) return;
      setSelectionResult(r);
    };
    const guardedSetSelectionLoading = (l: boolean) => {
      if (!stillOnStartedPaper()) return;
      setSelectionLoading(l);
    };

    try {
      const res = await api.analyzeSelectionStream(startedFor, text, action, controller.signal);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const detail = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(detail).detail || msg; } catch { /* ignore */ }
        if (res.status === 403 || res.status === 429) {
          guardedSetSelectionResult({ action, selected_text: text, explanation: `**Limit reached.** ${msg}\n\nUpgrade your plan to continue.` });
          guardedSetSelectionLoading(false);
          return;
        }
        throw new Error(msg);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      guardedSetSelectionResult({
        action,
        selected_text: text,
        explanation: "",
        streaming: true,
      });
      guardedSetSelectionLoading(false);

      while (true) {
        if (controller.signal.aborted) { reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "chunk") {
              accumulated += event.text;
              guardedSetSelectionResult({
                action,
                selected_text: text,
                explanation: accumulated,
                streaming: true,
              });
            } else if (event.type === "done") {
              const finalText = event.full_text || accumulated;
              const finalResult = {
                action,
                selected_text: text,
                explanation: finalText,
              };
              guardedSetSelectionResult(finalResult);
              // Server already persisted the selection to
              // `paper.cached_analysis.selections` via `append_capped`
              // before returning `done`, so on any future page load the
              // hydrate-from-server effect will restore it. Here we only
              // update the in-memory history — and only if we're still
              // viewing the paper this stream started for.
              if (stillOnStartedPaper()) {
                addSelectionToHistory(finalResult);
                refreshUsage();
              }
            } else if (event.type === "error") {
              guardedSetSelectionResult({
                action,
                selected_text: text,
                explanation: `Error: ${event.message}`,
              });
            }
          } catch {
            // ignore malformed SSE
          }
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      guardedSetSelectionResult({
        action,
        selected_text: text,
        explanation: `Analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      });
      guardedSetSelectionLoading(false);
    }
  }, [activePaperId, setPanelVisible, setActiveTab, setSelectionLoading, setSelectionResult, addSelectionToHistory, refreshUsage]);

  const onDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Pointer events + setPointerCapture give reliable move/up delivery even
      // when the cursor leaves the thin handle, iframes are on the page, or
      // the PDF canvas happens to be underneath. Previously we used mouse
      // events on `window`, which lost the stream in some Safari/Webkit
      // configurations once the cursor crossed back over the PDF on side
      // layouts — so dragging felt broken on left/right orientations.
      e.preventDefault();
      const target = e.currentTarget;
      try { target.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      dragging.current = true;
      const isHoriz = panelPos !== "bottom";
      startCoord.current = isHoriz ? e.clientX : e.clientY;
      startSize.current = panelSize;
      document.body.style.cursor = isHoriz ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [panelSize, panelPos]
  );

  const onDragMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const isHoriz = panelPos !== "bottom";
      const min = isHoriz ? MIN_SIDE : MIN_BOTTOM;
      const max = isHoriz ? MAX_SIDE : MAX_BOTTOM;
      let delta: number;
      if (panelPos === "right") delta = startCoord.current - e.clientX;
      else if (panelPos === "left") delta = e.clientX - startCoord.current;
      else delta = startCoord.current - e.clientY;
      setPanelSize(Math.min(max, Math.max(min, startSize.current + delta)));
    },
    [panelPos]
  );

  const onDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const cyclePosition = useCallback(() => {
    setPanelPos((cur) => {
      const idx = POSITIONS.indexOf(cur);
      const next = POSITIONS[(idx + 1) % POSITIONS.length];
      setPanelSize(readStoredSize(next));
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center space-y-3 animate-fade-in">
          <div className="w-6 h-6 border-2 border-border border-t-foreground rounded-full animate-spin mx-auto" />
          <p className="text-[14px] text-muted-foreground">Loading paper…</p>
        </div>
      </div>
    );
  }

  if (error || !paper) {
    return (
      <div className="flex-1 flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center space-y-4 animate-fade-in">
          <p className="text-destructive text-[14px]">{error || "Paper not found"}</p>
          <button
            onClick={() => router.push("/dashboard")}
            className="text-[13px] text-muted-foreground hover:text-foreground/90 transition-colors"
          >
            &larr; Back to library
          </button>
        </div>
      </div>
    );
  }

  const isBottom = panelPos === "bottom";

  // The 6px handles we had before were technically correct but too thin to
  // grab on side layouts (the PDF canvas was often right next to them).
  // Wider hit targets + pointer events fix reliable dragging on left/right.
  const dragHandle = isBottom ? (
    <div
      className="shrink-0 h-2.5 w-full flex items-center justify-center cursor-row-resize group hover:bg-accent/60 transition-colors touch-none select-none"
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      role="separator"
      aria-orientation="horizontal"
    >
      <div className="h-[2px] w-10 rounded-full bg-foreground/8 group-hover:bg-foreground/20 transition-colors pointer-events-none" />
    </div>
  ) : (
    <div
      className="shrink-0 w-2.5 h-full flex items-center justify-center cursor-col-resize group hover:bg-accent/60 transition-colors touch-none select-none"
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
      role="separator"
      aria-orientation="vertical"
    >
      <div className="w-[2px] h-8 rounded-full bg-foreground/8 group-hover:bg-foreground/20 transition-colors pointer-events-none" />
    </div>
  );

  const panelInner = (
    <div
      className={`h-full ${
        isBottom ? "mx-auto max-w-3xl border-l border-r border-t border-border rounded-t-xl" : ""
      }`}
    >
      <AnalysisPanel
        paperId={activePaperId}
        position={panelPos}
        onCyclePosition={cyclePosition}
      />
    </div>
  );

  const pdfInner = (
    <>
      <PdfViewer
        url={api.getPdfUrl(activePaperId)}
        paperId={activePaperId}
        onTextSelected={handleTextSelected}
        onSelectionClear={handleSelectionClear}
      />
      {selection && (
        <SelectionToolbar
          text={selection.text}
          rect={selection.rect}
          onAction={handleSelectionAction}
          onDismiss={handleSelectionClear}
        />
      )}
    </>
  );

  const showSessionBar = canMultiPaper && sessionPapers.length > 1;

  return (
    <>
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-4 h-[48px] border-b border-border glass-nav z-30 relative">
        <button
          onClick={() => { clearSession(); router.push("/dashboard"); }}
          className="text-muted-foreground hover:text-foreground transition-colors text-[13px] font-medium shrink-0 ring-focus rounded-md px-1"
          aria-label="Back to dashboard"
        >
          &larr;
        </button>
        <div className="h-4 w-px bg-border shrink-0" />
        <Image src="/logo.png" alt="Know" width={20} height={20} className="shrink-0 rounded-md" />

        {!showSessionBar && (
          <span className="text-[13px] text-muted-foreground truncate flex-1 font-medium">
            {paper.title}
          </span>
        )}

        {showSessionBar && (
          <span className="text-[11px] text-muted-foreground truncate flex-1 font-medium uppercase tracking-wider">
            Session · {sessionPapers.length} papers
          </span>
        )}

        {/* Usage indicator */}
        {paperUsage && paperUsage.qa_limit > 0 && (
          <div className="hidden sm:flex items-center gap-2 shrink-0 text-[10px] text-muted-foreground">
            <span title={`${paperUsage.qa_used} of ${paperUsage.qa_limit} Q&A used on this paper`}>
              Q&A {paperUsage.qa_used}/{paperUsage.qa_limit}
            </span>
            <span className="text-muted-foreground/50">|</span>
            <span title={`${paperUsage.selections_used} of ${paperUsage.selections_limit} selections used on this paper`}>
              Selections {paperUsage.selections_used}/{paperUsage.selections_limit}
            </span>
          </div>
        )}

        {/* Add paper button */}
        {canMultiPaper && (
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={() => { setShowFolderPicker(false); setShowWorkspaceMenu(false); setShowAddPaper(!showAddPaper); }}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground/90 px-2 py-1 rounded-md hover:bg-accent/60 transition-colors"
            title="Add paper to session"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="hidden sm:inline">Add Paper</span>
          </button>
          {showAddPaper && (
            <AddPaperPopover
              sessionIds={sessionIds}
              onAdd={handleAddPaper}
              onClose={() => setShowAddPaper(false)}
            />
          )}
        </div>
        )}

        {/* Folder assignment */}
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={() => { setShowAddPaper(false); setShowWorkspaceMenu(false); setShowFolderPicker(!showFolderPicker); }}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground/90 px-2 py-1 rounded-md hover:bg-accent/60 transition-colors"
            title="Assign to folder"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
            {paper.folder || "No folder"}
          </button>
          {showFolderPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 glass-strong rounded-2xl shadow-lg p-2 w-64 max-w-[calc(100vw-1rem)] space-y-1 animate-fade-in">
              <button
                onClick={() => handleMoveToFolder("")}
                className={`w-full text-left text-[11px] px-2 py-1.5 rounded-md transition-colors ${
                  !paper.folder ? "bg-accent font-medium" : "hover:bg-accent/50"
                }`}
              >
                Unfiled
              </button>
              {allFolders.map((f) => (
                <button
                  key={f}
                  onClick={() => handleMoveToFolder(f)}
                  className={`w-full text-left text-[11px] px-2 py-1.5 rounded-md transition-colors truncate ${
                    paper.folder === f ? "bg-accent font-medium" : "hover:bg-accent/50"
                  }`}
                >
                  {f}
                </button>
              ))}
              <div className="border-t border-border pt-1.5 mt-1.5">
                {/* min-w-0 lets the flex child (<input>) shrink below its
                    intrinsic placeholder width. Without it the input kept its
                    ~100px "New folder..." default and pushed the Add button
                    out of the 192px dropdown. */}
                <div className="flex gap-1 items-center">
                  <input
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateAndMoveToFolder()}
                    placeholder="New folder..."
                    className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded-md border border-border bg-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    autoFocus
                  />
                  <button
                    onClick={handleCreateAndMoveToFolder}
                    disabled={!folderInput.trim()}
                    className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md btn-primary-glass text-background transition-opacity disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Export citations for current paper */}
        {!isFree && (
        <button
          onClick={() => handleExportBibtex({ paper_ids: [activePaperId] }, "Current paper")}
          className="shrink-0 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground/90 px-2 py-1 rounded-md hover:bg-accent/60 transition-colors"
          title="Export citations for current paper"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
          </svg>
          <span className="hidden sm:inline">Citations</span>
        </button>
        )}

        {/* Workspace save/load */}
        {canMultiPaper && (
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={handleOpenWorkspaceMenu}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground/90 px-2 py-1 rounded-md hover:bg-accent/60 transition-colors"
            title="Save or load workspace"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
            </svg>
            <span className="hidden sm:inline">{activeWorkspaceName || "Workspace"}</span>
          </button>
          {showWorkspaceMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 glass-strong rounded-2xl shadow-xl w-80 max-h-[400px] flex flex-col animate-fade-in">
              <div className="p-3 border-b border-border space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground/80">Save Current Session</p>
                <div className="flex gap-1.5">
                  <input
                    value={workspaceNameInput}
                    onChange={(e) => setWorkspaceNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveWorkspace(); }}
                    placeholder={`Session — ${sessionPapers.length} papers`}
                    className="flex-1 text-[12px] px-2.5 py-1.5 rounded-xl border border-border bg-background/70 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus-visible:ring-ring/40"
                  />
                  <button
                    onClick={handleSaveWorkspace}
                    disabled={workspaceSaving}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-xl btn-primary-glass text-white transition-all disabled:opacity-50 shrink-0"
                  >
                    {workspaceSaving ? "..." : workspaceSaved ? "Saved!" : "Save"}
                  </button>
                </div>
              </div>

              <div className="overflow-y-auto flex-1 p-1.5">
                {!workspacesLoaded ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="w-4 h-4 border-2 border-border border-t-foreground rounded-full animate-spin" />
                  </div>
                ) : savedWorkspaces.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/80 text-center py-6">No saved workspaces yet</p>
                ) : (
                  <>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground/80 px-2 py-1.5">
                      Load Workspace
                    </p>
                    {savedWorkspaces.map((ws) => (
                      <div
                        key={ws.id}
                        className="flex items-center gap-2 rounded-xl px-2.5 py-2 hover:bg-accent/50 transition-colors group"
                      >
                        <button
                          onClick={() => handleLoadWorkspace(ws)}
                          className="flex-1 text-left min-w-0"
                        >
                          <p className="text-[12px] font-medium text-foreground/90 truncate">{ws.name}</p>
                          <p className="text-[10px] text-muted-foreground/80">
                            {ws.paper_ids.length} paper{ws.paper_ids.length !== 1 ? "s" : ""}
                            {" · "}
                            {new Date(ws.updated_at).toLocaleDateString()}
                          </p>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExportBibtex({ workspace_id: ws.id }, `Workspace: ${ws.name}`); }}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-muted-foreground transition-all shrink-0"
                          title="Export BibTeX"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteWorkspace(ws.id); }}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-destructive transition-all shrink-0"
                          title="Delete workspace"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="p-2 border-t border-border">
                <button
                  onClick={() => setShowWorkspaceMenu(false)}
                  className="w-full text-[11px] text-muted-foreground/80 hover:text-foreground/90 py-1 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
        )}

        <button
          onClick={togglePanel}
          className={`text-[12px] font-medium transition-colors shrink-0 ${
            panelVisible ? "text-foreground" : "text-muted-foreground hover:text-foreground/90"
          }`}
        >
          {panelVisible ? "Hide Analysis" : "Show Analysis"}
        </button>
        <ThemeToggle />
        <button
          onClick={() => router.push("/settings")}
          className="text-muted-foreground/60 hover:text-muted-foreground transition-colors shrink-0 ring-focus rounded-md p-1"
          aria-label="Settings"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <UserButton
          appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }}
        >
          <UserButton.MenuItems>
            <UserButton.Link label="Settings" labelIcon={<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>} href="/settings" />
          </UserButton.MenuItems>
        </UserButton>
      </header>

      {/* Session paper tabs */}
      {showSessionBar && (
        <div className="shrink-0 border-b border-border glass-subtle px-3 py-1.5">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {sessionPapers.map((sp) => (
              // Tab + close button are siblings inside a group wrapper so we
              // avoid the invalid/confusing pattern of a focusable close
              // control nested inside a <button>. Keyboard users can now tab
              // to each control independently and both announce their own
              // accessible name.
              <div
                key={sp.id}
                role="group"
                aria-label={sp.title}
                className={`group flex items-center rounded-full text-[11px] font-medium transition-all shrink-0 ${
                  sp.id === activePaperId
                    ? "btn-primary-glass"
                    : "glass-subtle text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSwitchPaper(sp.id)}
                  className="pl-3 pr-1.5 py-1 flex items-center rounded-l-full"
                  aria-current={sp.id === activePaperId ? "page" : undefined}
                >
                  <span className="max-w-[180px] truncate">
                    {sp.title.length > 35 ? sp.title.slice(0, 35) + "..." : sp.title}
                  </span>
                </button>
                {sessionPapers.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveSessionPaper(sp.id)}
                    aria-label={`Remove ${sp.title} from session`}
                    className={`mr-1.5 w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                      sp.id === activePaperId
                        ? "hover:bg-background/20 text-background/60 hover:text-background"
                        : "hover:bg-foreground/10 text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                  >
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main content — single stable container so AnalysisPanel never unmounts on orientation change */}
      <div
        className={`flex-1 flex overflow-hidden ${isBottom ? "flex-col" : "flex-row"}`}
        style={{ minHeight: 0 }}
      >
        <div
          className="flex-1 overflow-hidden relative"
          style={{ minWidth: 0, minHeight: 0, order: panelPos === "left" ? 3 : 1 }}
        >
          {pdfInner}
        </div>
        <div
          className="shrink-0 relative z-10"
          style={{
            order: 2,
            display: panelVisible ? undefined : "none",
            ...(isBottom ? { width: "100%" } : { height: "100%" }),
          }}
        >
          {dragHandle}
        </div>
        <div
          className={`shrink-0 overflow-hidden bg-background ${isBottom ? "" : "border-l border-r border-t border-border"}`}
          style={{
            ...(isBottom ? { height: panelSize } : { width: panelSize }),
            order: panelPos === "left" ? 1 : 3,
            display: panelVisible ? undefined : "none",
          }}
        >
          {panelInner}
        </div>
      </div>
    </div>

      <BibtexModal
        open={bibtexModal.open}
        onClose={() => setBibtexModal({ open: false })}
        paperIds={bibtexModal.paperIds}
        workspaceId={bibtexModal.workspaceId}
        label={bibtexModal.label}
      />
    </>
  );
}

export default function PaperPage() {
  return <PaperContent />;
}
