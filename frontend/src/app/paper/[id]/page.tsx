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
import { useUserTier, canAccess } from "@/lib/UserTierContext";

const PdfViewer = dynamic(
  () => import("@/components/pdf/PdfViewer").then((m) => m.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
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

const autoAnalyzedPapers = new Set<string>();
const activeRequests = new Map<string, Set<string>>();

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
    setUploading(true);
    try {
      const paper = await api.uploadPaper(file);
      onAdd(paper.id, paper.title);
    } catch (e) {
      console.error("Upload failed:", e);
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
      <div className="p-2.5 border-b border-black/[0.06] space-y-2">
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
      </div>

      <div className="overflow-y-auto flex-1">
        {loadingPapers ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
          </div>
        ) : selectedFolder === null ? (
          /* Folder list */
          <div className="p-1.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400 px-2.5 py-1.5">
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
                  className="w-full text-left flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 hover:bg-gray-50 transition-colors group"
                >
                  <svg className="w-4 h-4 text-gray-300 group-hover:text-gray-500 transition-colors shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  <span className="text-[12px] font-medium text-gray-700 flex-1 truncate">{f}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums">{count}</span>
                  <svg className="w-3.5 h-3.5 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
              className="flex items-center gap-1.5 text-[11px] font-medium text-gray-400 hover:text-gray-700 transition-colors px-2 py-1.5 mb-0.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              {selectedFolder}
            </button>
            {folderPapers.length === 0 ? (
              <p className="text-[12px] text-gray-400 text-center py-6">No papers in this folder</p>
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
                        : "hover:bg-gray-50 cursor-pointer"
                    }`}
                  >
                    <p className="text-[12px] font-medium text-gray-800 truncate leading-tight">
                      {p.title}
                    </p>
                    <p className="text-[10px] text-gray-400 truncate mt-0.5">
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
    setSummary,
    sessionPapers, addSessionPaper, removeSessionPaper, clearSession,
    savePaperCache, restorePaperCache, updatePaperCache,
    setQAResults, clearQuestions,
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
      cacheRestoredRef.current = restored;
      setActivePaperId(paperId);
    }
  }, [paperId]);
  const [panelSize, setPanelSize] = useState(DEFAULT_SIDE);
  const [panelPos, setPanelPos] = useState<PanelPosition>("right");
  const dragging = useRef(false);
  const startCoord = useRef(0);
  const startSize = useRef(0);

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

  // Load paper when activePaperId changes — always fetch fresh to pick up folder/tag updates
  // First try to restore from local cache for instant display
  const cacheRestoredRef = useRef(false);
  useEffect(() => {
    const store = useStore.getState();
    if (store.preReading || store.summary) {
      cacheRestoredRef.current = true;
    }
  }, [activePaperId]);

  useEffect(() => {
    let stale = false;
    if (!initialLoadDone.current) setLoading(true);
    setError("");
    api
      .getPaper(activePaperId)
      .then((p) => {
        if (!stale) { setPaper(p); initialLoadDone.current = true; }
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => { stale = true; };
  }, [activePaperId, setPaper, setLoading]);

  // Auto-analyze when paper loads (skip if cache was already restored or already analyzed this paper)
  useEffect(() => {
    if (!paper || paper.id !== activePaperId) return;
    if (tierLoading) return;
    if (autoAnalyzedPapers.has(activePaperId)) return;

    const store = useStore.getState();
    if (cacheRestoredRef.current || store.preReading || store.summary) {
      autoAnalyzedPapers.add(activePaperId);
      return;
    }

    autoAnalyzedPapers.add(activePaperId);

    const pid = activePaperId;
    const cache = paper.cached_analysis || {};

    if (paper.notes) setNotes(paper.notes);

    if (cache.selections && cache.selections.length > 0) {
      const currentHistory = store.selectionHistory;
      if (currentHistory.length === 0) {
        for (const sel of cache.selections) {
          store.addSelectionToHistory(sel as SelectionAnalysisResult);
        }
      }
    }

    const pending = activeRequests.get(pid) ?? new Set<string>();
    activeRequests.set(pid, pending);

    if (cache.pre_reading) {
      setPreReading(cache.pre_reading);
    } else if (canAccess(tierUser?.tier || "free", "prepare") && !pending.has("preReading")) {
      pending.add("preReading");
      setPreReadingLoading(true);
      api.analyze(pid)
        .then((r) => {
          const s = useStore.getState();
          if (s.paper?.id === pid) setPreReading(r);
          else updatePaperCache(pid, { preReading: r });
        })
        .catch(() => {})
        .finally(() => {
          pending.delete("preReading");
          const s = useStore.getState();
          if (s.paper?.id === pid) {
            setPreReadingLoading(false);
          } else if (s.preReadingLoading) {
            setPreReadingLoading(false);
          }
        });
    }

    if (cache.assumptions) {
      setAssumptions(cache.assumptions.assumptions || []);
    } else if (canAccess(tierUser?.tier || "free", "assumptions") && !pending.has("assumptions")) {
      pending.add("assumptions");
      setAssumptionsLoading(true);
      api.getAssumptions(pid)
        .then((r) => {
          const s = useStore.getState();
          if (s.paper?.id === pid) setAssumptions(r.assumptions);
          else updatePaperCache(pid, { assumptions: r.assumptions });
        })
        .catch(() => {})
        .finally(() => {
          pending.delete("assumptions");
          const s = useStore.getState();
          if (s.paper?.id === pid) {
            setAssumptionsLoading(false);
          } else if (s.assumptionsLoading) {
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
      if (allItems.length > 0) {
        useStore.getState().setQAResults(allItems);
      }
    }
  }, [paper, activePaperId, tierUser?.tier, tierLoading, setPreReading, setPreReadingLoading, setAssumptions, setAssumptionsLoading, setNotes, setSummary, updatePaperCache]);

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
    cacheRestoredRef.current = restored;
    setActivePaperId(id);
  }, [activePaperId, savePaperCache, restorePaperCache, resetAnalysisState]);

  const handleAddPaper = useCallback((id: string, title: string) => {
    addSessionPaper({ id, title });
    setShowAddPaper(false);
  }, [addSessionPaper]);

  const handleRemoveSessionPaper = useCallback((id: string) => {
    if (sessionPapers.length <= 1) return;
    removeSessionPaper(id);
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
    clearSession();
    clearCrossPaperResults();

    if (ws.cross_paper_results && ws.cross_paper_results.length > 0) {
      addCrossPaperResults(ws.cross_paper_results);
    }

    for (const pid of ws.paper_ids) {
      try {
        const p = await api.getPaper(pid);
        addSessionPaper({ id: p.id, title: p.title });
      } catch {
        // paper may have been deleted
      }
    }

    if (ws.paper_ids.length > 0) {
      const firstId = ws.paper_ids[0];
      setActivePaperId(firstId);
      if (firstId !== paperId) {
        router.push(`/paper/${firstId}`);
      }
    }
    setShowWorkspaceMenu(false);
    setActiveWorkspaceName(ws.name);
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
    try {
      await api.deleteWorkspace(wsId);
      setSavedWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
    } catch {
      // ignore
    }
  }, []);

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

  const refreshUsage = useCallback(() => {
    api.getPaperUsage(activePaperId).then(setPaperUsage).catch(() => {});
  }, [activePaperId]);

  useEffect(() => { refreshUsage(); }, [refreshUsage]);

  const handleTextSelected = useCallback((text: string, rect: DOMRect) => {
    setSelection({ text, rect });
  }, []);

  const handleSelectionClear = useCallback(() => {
    setSelection(null);
  }, []);

  const handleSelectionAction = useCallback(async (action: SelectionAction, text: string) => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();

    if (action === "note") {
      setPanelVisible(true);
      setActiveTab("notes");
      try {
        const note = await api.addNote(activePaperId, text, "PDF Selection");
        useStore.getState().addNote(note);
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

    try {
      const res = await api.analyzeSelectionStream(activePaperId, text, action);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const detail = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(detail).detail || msg; } catch { /* ignore */ }
        if (res.status === 403 || res.status === 429) {
          setSelectionResult({ action, selected_text: text, explanation: `**Limit reached.** ${msg}\n\nUpgrade your plan to continue.` });
          setSelectionLoading(false);
          return;
        }
        throw new Error(msg);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      setSelectionResult({
        action,
        selected_text: text,
        explanation: "",
        streaming: true,
      });
      setSelectionLoading(false);

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
              setSelectionResult({
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
              setSelectionResult(finalResult);
              addSelectionToHistory(finalResult);
              refreshUsage();
            } else if (event.type === "error") {
              setSelectionResult({
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
      setSelectionResult({
        action,
        selected_text: text,
        explanation: `Analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      });
      setSelectionLoading(false);
    }
  }, [activePaperId, setPanelVisible, setActiveTab, setSelectionLoading, setSelectionResult, addSelectionToHistory, refreshUsage]);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const isHoriz = panelPos !== "bottom";
      startCoord.current = isHoriz ? e.clientX : e.clientY;
      startSize.current = panelSize;
      document.body.style.cursor = isHoriz ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const min = isHoriz ? MIN_SIDE : MIN_BOTTOM;
      const max = isHoriz ? MAX_SIDE : MAX_BOTTOM;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        let delta: number;
        if (panelPos === "right") delta = startCoord.current - ev.clientX;
        else if (panelPos === "left") delta = ev.clientX - startCoord.current;
        else delta = startCoord.current - ev.clientY;
        setPanelSize(Math.min(max, Math.max(min, startSize.current + delta)));
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panelSize, panelPos]
  );

  const cyclePosition = useCallback(() => {
    setPanelPos((cur) => {
      const idx = POSITIONS.indexOf(cur);
      const next = POSITIONS[(idx + 1) % POSITIONS.length];
      setPanelSize(next === "bottom" ? DEFAULT_BOTTOM : DEFAULT_SIDE);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-screen bg-white">
        <div className="text-center space-y-3 animate-fade-in">
          <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-600 rounded-full animate-spin mx-auto" />
          <p className="text-[14px] text-gray-500">Loading paper...</p>
        </div>
      </div>
    );
  }

  if (error || !paper) {
    return (
      <div className="flex-1 flex items-center justify-center h-screen bg-white">
        <div className="text-center space-y-4 animate-fade-in">
          <p className="text-red-500 text-[14px]">{error || "Paper not found"}</p>
          <button
            onClick={() => router.push("/dashboard")}
            className="text-[13px] text-gray-500 hover:text-gray-700 transition-colors"
          >
            &larr; Back to library
          </button>
        </div>
      </div>
    );
  }

  const isBottom = panelPos === "bottom";

  const dragHandle = isBottom ? (
    <div
      className="shrink-0 h-1.5 flex items-center justify-center cursor-row-resize group hover:bg-accent/60 transition-colors"
      onMouseDown={onDragStart}
    >
      <div className="h-[2px] w-10 rounded-full bg-foreground/8 group-hover:bg-foreground/20 transition-colors" />
    </div>
  ) : (
    <div
      className="shrink-0 w-1.5 flex items-center justify-center cursor-col-resize group hover:bg-accent/60 transition-colors"
      onMouseDown={onDragStart}
    >
      <div className="w-[2px] h-8 rounded-full bg-foreground/8 group-hover:bg-foreground/20 transition-colors" />
    </div>
  );

  const panelBlock = isBottom ? (
    <div
      className="shrink-0 overflow-hidden bg-background"
      style={{ height: panelSize }}
    >
      <div className="mx-auto max-w-3xl h-full border-l border-r border-t rounded-t-xl">
        <AnalysisPanel
          paperId={activePaperId}
          position={panelPos}
          onCyclePosition={cyclePosition}
        />
      </div>
    </div>
  ) : (
    <div
      className="shrink-0 overflow-hidden bg-background border-l border-r border-t"
      style={{ width: panelSize }}
    >
      <AnalysisPanel
        paperId={activePaperId}
        position={panelPos}
        onCyclePosition={cyclePosition}
      />
    </div>
  );

  const pdfBlock = (
    <div className="flex-1 overflow-hidden relative" style={{ minWidth: 0, minHeight: 0 }}>
      <PdfViewer
        url={api.getPdfUrl(activePaperId)}
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
    </div>
  );

  const showSessionBar = !isFree && sessionPapers.length > 1;

  return (
    <>
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-4 h-[48px] border-b border-black/[0.06] glass-nav z-30 relative">
        <button
          onClick={() => { clearSession(); router.push("/dashboard"); }}
          className="text-gray-500 hover:text-gray-700 transition-colors text-[13px] font-medium shrink-0"
        >
          &larr;
        </button>
        <div className="h-4 w-px bg-black/[0.06] shrink-0" />
        <Image src="/logo.png" alt="Know" width={20} height={20} className="shrink-0 rounded-md" />

        {!showSessionBar && (
          <span className="text-[13px] text-gray-600 truncate flex-1 font-medium">
            {paper.title}
          </span>
        )}

        {showSessionBar && (
          <span className="text-[11px] text-gray-500 truncate flex-1 font-medium uppercase tracking-wider">
            Session · {sessionPapers.length} papers
          </span>
        )}

        {/* Usage indicator */}
        {paperUsage && paperUsage.qa_limit > 0 && (
          <div className="hidden sm:flex items-center gap-2 shrink-0 text-[10px] text-gray-500">
            <span title={`${paperUsage.qa_used} of ${paperUsage.qa_limit} Q&A used on this paper`}>
              Q&A {paperUsage.qa_used}/{paperUsage.qa_limit}
            </span>
            <span className="text-gray-200">|</span>
            <span title={`${paperUsage.selections_used} of ${paperUsage.selections_limit} selections used on this paper`}>
              Selections {paperUsage.selections_used}/{paperUsage.selections_limit}
            </span>
          </div>
        )}

        {/* Add paper button */}
        {!isFree && (
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={() => { setShowFolderPicker(false); setShowWorkspaceMenu(false); setShowAddPaper(!showAddPaper); }}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-50 transition-colors"
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
            className="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-50 transition-colors"
            title="Assign to folder"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
            {paper.folder || "No folder"}
          </button>
          {showFolderPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 glass-strong rounded-2xl shadow-lg p-2 w-48 space-y-1 animate-fade-in">
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
              <div className="border-t pt-1.5 mt-1.5">
                <div className="flex gap-1">
                  <input
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateAndMoveToFolder()}
                    placeholder="New folder..."
                    className="flex-1 text-[11px] px-2 py-1 rounded border bg-background"
                    autoFocus
                  />
                  <button
                    onClick={handleCreateAndMoveToFolder}
                    className="text-[10px] font-medium text-foreground px-1.5"
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
          className="shrink-0 flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-50 transition-colors"
          title="Export citations for current paper"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
          </svg>
          <span className="hidden sm:inline">Citations</span>
        </button>
        )}

        {/* Workspace save/load */}
        {!isFree && (
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={handleOpenWorkspaceMenu}
            className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-50 transition-colors"
            title="Save or load workspace"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
            </svg>
            <span className="hidden sm:inline">{activeWorkspaceName || "Workspace"}</span>
          </button>
          {showWorkspaceMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 glass-strong rounded-2xl shadow-xl w-80 max-h-[400px] flex flex-col animate-fade-in">
              <div className="p-3 border-b border-black/[0.06] space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">Save Current Session</p>
                <div className="flex gap-1.5">
                  <input
                    value={workspaceNameInput}
                    onChange={(e) => setWorkspaceNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveWorkspace(); }}
                    placeholder={`Session — ${sessionPapers.length} papers`}
                    className="flex-1 text-[12px] px-2.5 py-1.5 rounded-xl border border-black/[0.06] bg-white/50 placeholder:text-gray-300 focus:outline-none focus:ring-1 focus:ring-white/40"
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
                    <div className="w-4 h-4 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
                  </div>
                ) : savedWorkspaces.length === 0 ? (
                  <p className="text-[12px] text-gray-400 text-center py-6">No saved workspaces yet</p>
                ) : (
                  <>
                    <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400 px-2 py-1.5">
                      Load Workspace
                    </p>
                    {savedWorkspaces.map((ws) => (
                      <div
                        key={ws.id}
                        className="flex items-center gap-2 rounded-xl px-2.5 py-2 hover:bg-white/40 transition-colors group"
                      >
                        <button
                          onClick={() => handleLoadWorkspace(ws)}
                          className="flex-1 text-left min-w-0"
                        >
                          <p className="text-[12px] font-medium text-gray-700 truncate">{ws.name}</p>
                          <p className="text-[10px] text-gray-400">
                            {ws.paper_ids.length} paper{ws.paper_ids.length !== 1 ? "s" : ""}
                            {" · "}
                            {new Date(ws.updated_at).toLocaleDateString()}
                          </p>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExportBibtex({ workspace_id: ws.id }, `Workspace: ${ws.name}`); }}
                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-600 transition-all shrink-0"
                          title="Export BibTeX"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteWorkspace(ws.id); }}
                          className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all shrink-0"
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

              <div className="p-2 border-t border-black/[0.06]">
                <button
                  onClick={() => setShowWorkspaceMenu(false)}
                  className="w-full text-[11px] text-gray-400 hover:text-gray-700 py-1 transition-colors"
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
            panelVisible ? "text-gray-800" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {panelVisible ? "Hide Analysis" : "Show Analysis"}
        </button>
        <button
          onClick={() => router.push("/settings")}
          className="text-gray-300 hover:text-gray-500 transition-colors shrink-0"
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
        <div className="shrink-0 border-b border-black/[0.06] glass-subtle px-3 py-1.5">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {sessionPapers.map((sp) => (
              <button
                key={sp.id}
                type="button"
                className={`group flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer shrink-0 ${
                  sp.id === activePaperId
                    ? "bg-gradient-to-r from-gray-800 to-gray-900 text-white shadow-md shadow-gray-900/10"
                    : "glass-subtle text-gray-500 hover:bg-white/60 hover:text-gray-800"
                }`}
                onClick={() => handleSwitchPaper(sp.id)}
              >
                <span className="max-w-[180px] truncate">
                  {sp.title.length > 35 ? sp.title.slice(0, 35) + "..." : sp.title}
                </span>
                {sessionPapers.length > 1 && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveSessionPaper(sp.id);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); handleRemoveSessionPaper(sp.id); } }}
                    className={`w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                      sp.id === activePaperId
                        ? "hover:bg-background/20 text-background/60 hover:text-background"
                        : "hover:bg-foreground/10 text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main content */}
      {isBottom ? (
        <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
          {pdfBlock}
          {panelVisible && (
            <>
              {dragHandle}
              {panelBlock}
            </>
          )}
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden" style={{ minHeight: 0 }}>
          {panelPos === "left" && panelVisible && (
            <>
              {panelBlock}
              {dragHandle}
            </>
          )}
          {pdfBlock}
          {panelPos === "right" && panelVisible && (
            <>
              {dragHandle}
              {panelBlock}
            </>
          )}
        </div>
      )}
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
