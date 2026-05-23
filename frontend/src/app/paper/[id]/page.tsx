"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { useShallow } from "zustand/react/shallow";
import { api, type SelectionAnalysisResult, type PaperListEntry, type ParsedPaper, type PaperSummary } from "@/lib/api";
import { useStore } from "@/lib/store";
import { selectionKey } from "@/lib/selectionActions";
// Stage 2: streaming for selection moved to Next.js + AI SDK via this hook.
// The previous SSE consumer (`consumeSelectionSse`) is still used by the
// trial flow in `try/[id]/page.tsx`, so we don't delete it yet.
import { useSelectionThread } from "@/lib/useSelectionThread";
import { SelectionToolbar, type SelectionAction } from "@/components/pdf/SelectionToolbar";
import { AnalysisPanel, type PanelPosition } from "@/components/panel/BottomPanel";
import { BibtexModal } from "@/components/BibtexModal";
import { CitationScopeModal } from "@/components/CitationScopeModal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { ComingSoonNavControl } from "@/components/reader/ComingSoonNavControl";
import {
  WORKSPACE_FEATURES_COMING_SOON_TOOLTIP,
  WORKSPACE_FEATURES_TEMPORARILY_DISABLED,
  WORKSPACE_PAPER_LIMIT_MESSAGE,
  MAX_SESSION_PAPERS,
} from "@/lib/workspaceFeatureFlags";
import { UnpinnedPaperBanner } from "@/components/header/UnpinnedPaperBanner";
import { WorkspaceTruncationModal } from "@/components/workspaces/WorkspaceTruncationModal";
import type { WorkspaceRecord } from "@/lib/api";
import {
  resolveWorkspacePapers,
  getRememberedWorkspacePapers,
  applyWorkspaceSession,
  type LoadedWorkspacePaper,
} from "@/lib/workspaceSessionLoad";
import {
  hasActiveRequest,
  markRequestStart,
  markRequestEnd,
  clearProgressStart,
  forgetPaper,
  getCachedAssumptionItems,
  syncAutoAnalyzeGuardsFromCache,
  autoAnalyzedPapers,
  preReadingAutoRetryCooldownUntil,
  markAssumptionsAttemptFailed,
  assumptionsCooldownActive,
} from "@/lib/analysisState";
import { useSummaryStream, kickoffSummaryStream } from "@/lib/useSummaryStream";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { recordPaperOpened } from "@/lib/recentPapers";
import { isPreReadingPopulated } from "@/lib/preReading";
import { cn } from "@/lib/utils";
import { GoogleDriveButton } from "@/components/upload/GoogleDriveButton";
import { isGoogleDriveConfigured } from "@/lib/googleDrive";
import { PaperLoadingScreen } from "@/components/paper/PaperLoadingScreen";
import { isPaperFresh, markPaperFetched } from "@/lib/papersFreshness";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const PdfViewer = dynamic(
  () => import("@/components/pdf/PdfViewer").then((m) => m.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <PaperLoadingScreen
        title="Loading PDF"
        subtitle="Rendering pages…"
      />
    ),
  }
);

const MarkdownReader = dynamic(
  () => import("@/components/reader/MarkdownReader").then((m) => m.MarkdownReader),
  {
    ssr: false,
    loading: () => (
      <PaperLoadingScreen
        title="Loading reader"
        subtitle="Preparing readable view…"
      />
    ),
  }
);

const MIN_SIDE = 280;
const MAX_SIDE = 700;
const MIN_BOTTOM = 180;
const MAX_BOTTOM = 500;

const POSITIONS: PanelPosition[] = ["right", "bottom", "left"];

function mergeCachedAnalysis(current: ParsedPaper, previous?: ParsedPaper): ParsedPaper {
  if (!previous || previous.id !== current.id) return current;
  const incoming = current.cached_analysis || {};
  const prior = previous.cached_analysis || {};
  const merged = { ...incoming };

  // Per F-HYDRATION: a background Supabase rebuild can be slimmer than the
  // session cache. Preserve already-populated artifacts instead of flipping
  // the pane back to empty states on paper switch/refetch.
  for (const key of ["pre_reading", "summary", "selections", "qa_sessions", "figure_analyses"] as const) {
    const incomingValue = incoming[key];
    const priorValue = prior[key];
    const incomingEmpty = Array.isArray(incomingValue)
      ? incomingValue.length === 0
      : !incomingValue;
    if (incomingEmpty && priorValue) {
      (merged as Record<string, unknown>)[key] = priorValue;
    }
  }

  const incomingAssumptions = incoming.assumptions?.assumptions;
  const priorAssumptions = prior.assumptions?.assumptions;
  if (
    (!Array.isArray(incomingAssumptions) || incomingAssumptions.length === 0) &&
    Array.isArray(priorAssumptions) &&
    priorAssumptions.length > 0
  ) {
    merged.assumptions = prior.assumptions;
  }

  if (!merged.assumptions_cooldown_until && prior.assumptions_cooldown_until) {
    merged.assumptions_cooldown_until = prior.assumptions_cooldown_until;
  }

  return {
    ...current,
    cached_analysis: merged,
    figures: current.figures?.length ? current.figures : previous.figures,
    notes: current.notes?.length ? current.notes : previous.notes,
  };
}

/**
 * Inline, Google-Docs-style paper rename control.
 *
 * Renders the current title as text you can click to edit. Enter saves
 * (fires `onCommit`), Escape cancels and restores the original text, and
 * blur also saves. We deliberately render the editable surface as a
 * `contenteditable` span rather than swapping in an <input> so the
 * element keeps its exact typography, no layout shift, and no flash of
 * the wrong baseline between modes.
 *
 * The caller is responsible for the actual server write — the component
 * just emits sanitized, whitespace-collapsed output.
 */
function EditableTitle({
  value,
  className = "",
  placeholder = "Untitled paper",
  onCommit,
}: {
  value: string;
  className?: string;
  placeholder?: string;
  onCommit: (next: string) => void;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [editing, setEditing] = useState(false);

  // Keep the DOM text in sync with the incoming prop whenever we're
  // *not* in editing mode. While the user is typing, the DOM is the
  // source of truth — we don't want to clobber their in-flight edit
  // just because an unrelated state update re-rendered the tree.
  useEffect(() => {
    if (!ref.current) return;
    if (!editing && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value, editing]);

  const startEditing = () => {
    if (editing || !ref.current) return;
    setEditing(true);
    // Defer selection until the contenteditable is live, otherwise
    // focus() + selectAll can race and leave the cursor at position 0
    // with no visible selection (looks like the click did nothing).
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  };

  const commit = () => {
    const el = ref.current;
    if (!el) return;
    // Collapse all whitespace so a pasted title with embedded newlines
    // lands as a clean single-line string — same sanitation the server
    // applies, but avoids a round-trip jitter.
    const next = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    setEditing(false);
    if (!next) {
      // Restore original value instead of saving an empty title; the
      // backend rejects empty strings and the UI would flash blank.
      el.textContent = value;
      return;
    }
    if (next !== value) onCommit(next);
    else el.textContent = value;
  };

  const cancel = () => {
    if (!ref.current) return;
    ref.current.textContent = value;
    setEditing(false);
    ref.current.blur();
  };

  return (
    <span
      ref={ref}
      role="textbox"
      aria-label="Paper title — click to rename"
      title={editing ? undefined : "Click to rename"}
      contentEditable={editing}
      suppressContentEditableWarning
      spellCheck={false}
      onClick={startEditing}
      onFocus={() => { if (!editing) startEditing(); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLSpanElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onPaste={(e) => {
        // Plain-text paste only — pasting a selection from e.g. a PDF
        // can otherwise drop styled HTML into the title.
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      }}
      data-placeholder={placeholder}
      className={`outline-none rounded-md px-1.5 py-0.5 -mx-1.5 cursor-text transition-colors ${
        editing
          ? "bg-accent/60 ring-1 ring-border"
          : "hover:bg-accent/40"
      } ${className}`}
      tabIndex={0}
    >
      {value || placeholder}
    </span>
  );
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

  // Close on outside click / Escape — but never while an upload is in
  // flight. Previously the native file picker could trigger a stray
  // pointer event on return (varies by OS/browser) that closed the
  // popover mid-upload and unmounted the progress UI, making the user
  // think "nothing happened" even though the request was still
  // running in the background.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (uploading) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (uploading) return;
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, uploading]);

  // `uploading` is a count so multi-file uploads show the right
  // "Uploading 3..." label and only hide the spinner once they've
  // all resolved. Previously a single boolean meant the UI flicked
  // off the moment any one upload landed.
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const handleUploadFiles = useCallback(async (files: File[]) => {
    setUploadError(null);
    if (files.length === 0) return;

    // Client-side validation pass. Reject the entire batch if any
    // one file is bad — cleaner UX than silently dropping some
    // files from a multi-select.
    for (const f of files) {
      if (f.size > MAX_UPLOAD_BYTES) {
        setUploadError(
          `"${f.name}" is too large (${(f.size / 1024 / 1024).toFixed(1)} MB). Max ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB.`
        );
        return;
      }
      if (!f.name.toLowerCase().endsWith(".pdf")) {
        setUploadError(`"${f.name}" is not a PDF.`);
        return;
      }
    }

    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });

    // Upload in parallel — the server accepts concurrent requests
    // and this parallelises I/O (networking + PDF parsing) so the
    // user isn't waiting serially through a large batch. We also
    // hand off the first completion to `onAdd` *as soon as it's
    // ready*, which unmounts the popover and lets the user start
    // reading while the rest finish in the background.
    let firstHandled = false;
    let firstError: string | null = null;
    const { cachePaper, addSessionPaper } = useStore.getState();

    const tasks = files.map(async (file) => {
      try {
        const paper = await api.uploadPaper(file);
        // Always register with the global store so the tab appears
        // in the session bar regardless of which one finishes first
        // and even if this component has already unmounted.
        cachePaper(paper);
        // Track C2: pre-seed the freshness marker so the reader page
        // doesn't waste a network round-trip refetching what the
        // upload just returned.
        markPaperFetched(paper.id);
        const added = addSessionPaper({ id: paper.id, title: paper.title });
        if (!added && !firstError) {
          firstError = WORKSPACE_PAPER_LIMIT_MESSAGE;
        }
        if (added && !firstHandled) {
          firstHandled = true;
          onAdd(paper.id, paper.title);
        }
      } catch (e) {
        if (!firstError) {
          firstError = e instanceof Error ? e.message : "Upload failed.";
        }
      } finally {
        setUploadProgress((p) => ({ done: p.done + 1, total: p.total }));
      }
    });

    await Promise.allSettled(tasks);
    if (firstError) setUploadError(firstError);
    setUploading(false);
    setUploadProgress({ done: 0, total: 0 });
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
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Reset the value so selecting the *same* file again still
            // fires `change`. Without this, re-picking a PDF the user
            // already tried once would appear to do nothing at all.
            e.target.value = "";
            if (files.length > 0) handleUploadFiles(files);
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full flex items-center justify-center gap-2 text-[12px] font-semibold px-3 py-2.5 rounded-xl btn-primary-glass text-white transition-opacity disabled:opacity-50"
        >
          {uploading ? (
            <>
              <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              {uploadProgress.total > 1
                ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                : "Uploading…"}
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              Upload Papers
            </>
          )}
        </button>
        {isGoogleDriveConfigured() && (
          <GoogleDriveButton
            onFile={(file) => handleUploadFiles([file])}
            disabled={uploading}
            maxBytes={MAX_UPLOAD_BYTES}
            onError={setUploadError}
          />
        )}
        {/* Small hint so users know they can batch-upload. */}
        <p className="text-[10.5px] text-muted-foreground/70 text-center leading-snug px-1">
          Tip: you can select multiple PDFs at once.
        </p>
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
  // Don't treat "tier is loading" as free — that hid Scholar/Researcher
  // affordances during every background `refresh()` (e.g. returning from
  // another browser tab). Unknown signed-in tier before first fetch: still no
  // `tierUser`, so gated features stay off until data arrives.
  const isFree = !tierUser || tierUser.tier === "free";
  // Multi-paper sessions + workspaces are only useful alongside cross-paper
  // Q&A. Gate them on the same `multi-qa` feature so Scholar users don't
  // open a session they can't meaningfully use.
  const canMultiPaper = !tierLoading && !!tierUser && canAccess(tierUser.tier, "multi-qa");
  const workspaceFeaturesComingSoon = WORKSPACE_FEATURES_TEMPORARILY_DISABLED;
  const paperId = params.id as string;
  const { paper, setPaper, loading, setLoading, cachePaper } = useStore(
    useShallow((s) => ({
      paper: s.paper,
      setPaper: s.setPaper,
      loading: s.loading,
      setLoading: s.setLoading,
      cachePaper: s.cachePaper,
    })),
  );
  const { panelVisible, setPanelVisible, togglePanel, uiPrefs, setPanelPosition, setPanelSize: setStoredPanelSize } = useStore(
    useShallow((s) => ({
      panelVisible: s.panelVisible,
      setPanelVisible: s.setPanelVisible,
      togglePanel: s.togglePanel,
      uiPrefs: s.uiPrefs,
      setPanelPosition: s.setPanelPosition,
      setPanelSize: s.setPanelSize,
    })),
  );
  const { headerHidden, setHeaderHidden, focusMode, toggleFocusMode, setFocusMode } = useStore(
    useShallow((s) => ({
      headerHidden: s.headerHidden,
      setHeaderHidden: s.setHeaderHidden,
      focusMode: s.focusMode,
      toggleFocusMode: s.toggleFocusMode,
      setFocusMode: s.setFocusMode,
    })),
  );
  const {
    setPreReadingForPaper, setPreReadingLoadingForPaper,
    setAssumptionsForPaper, setAssumptionsLoadingForPaper,
    setSummaryLoadingForPaper,
  } = useStore(
    useShallow((s) => ({
      setPreReadingForPaper: s.setPreReadingForPaper,
      setPreReadingLoadingForPaper: s.setPreReadingLoadingForPaper,
      setAssumptionsForPaper: s.setAssumptionsForPaper,
      setAssumptionsLoadingForPaper: s.setAssumptionsLoadingForPaper,
      setSummaryLoadingForPaper: s.setSummaryLoadingForPaper,
    })),
  );
  const { setSelectionResultForPaper, upsertSelectionInHistoryForPaper, setActiveTab } = useStore(
    useShallow((s) => ({
      setSelectionResultForPaper: s.setSelectionResultForPaper,
      upsertSelectionInHistoryForPaper: s.upsertSelectionInHistoryForPaper,
      setActiveTab: s.setActiveTab,
    })),
  );
  const {
    sessionPapers, addSessionPaper, removeSessionPaper, clearWorkspaceSession, updatePaperTitle,
    crossPaperResults, addCrossPaperResults, clearCrossPaperResults,
  } = useStore(
    useShallow((s) => ({
      sessionPapers: s.sessionPapers,
      addSessionPaper: s.addSessionPaper,
      removeSessionPaper: s.removeSessionPaper,
      clearWorkspaceSession: s.clearWorkspaceSession,
      updatePaperTitle: s.updatePaperTitle,
      crossPaperResults: s.crossPaperResults,
      addCrossPaperResults: s.addCrossPaperResults,
      clearCrossPaperResults: s.clearCrossPaperResults,
    })),
  );

  // Reader chrome logic: focus mode *implies* a hidden header + session
  // bar, but we keep the two store flags separate so toggling focus
  // mode off can restore whatever header state the user had before.
  const chromeHidden = headerHidden || focusMode;
  const [error, setError] = useState("");

  const [activePaperId, setActivePaperId] = useState(paperId);
  const activePaperMeta = useStore(
    useShallow((s) => s.papersById[activePaperId] ?? s.paper),
  );
  const setStoreActivePaperId = useStore((s) => s.setActivePaperId);
  useEffect(() => {
    setStoreActivePaperId(activePaperId);
    return () => setStoreActivePaperId(null);
  }, [activePaperId, setStoreActivePaperId]);
  const useMarkdownReader = activePaperMeta?.ocr_status === "ready";
  const ocrKickoffRef = useRef<string | null>(null);

  // Retry OCR for uploads that failed or predated Mistral (pending/failed).
  useEffect(() => {
    const status = activePaperMeta?.ocr_status;
    if (!activePaperId || status === "ready" || status === "unsupported") return;
    if (ocrKickoffRef.current === activePaperId) return;
    ocrKickoffRef.current = activePaperId;

    void api
      .runPaperOcr(activePaperId)
      .then(async (res) => {
        if (res.ocr_status !== "ready") return;
        const refreshed = await api.getPaper(activePaperId);
        const merged = mergeCachedAnalysis(refreshed, useStore.getState().papersById[activePaperId]);
        cachePaper(merged);
        if (useStore.getState().paper?.id === activePaperId) {
          setPaper(merged);
        }
      })
      .catch(() => undefined);
  }, [activePaperId, activePaperMeta?.ocr_status, cachePaper, setPaper]);
  // Stage 2 migration: streaming + history + abort all flow through the
  // `useSelectionThread` hook below. The bare AbortController + SSE
  // parsing block this used to need is gone; the hook owns it.
  const selectionThread = useSelectionThread(activePaperId);
  useSummaryStream(activePaperId);
  const initialLoadDone = useRef(false);
  const summaryKickoffForRef = useRef<string | null>(null);
  const assumptionsKickoffForRef = useRef<string | null>(null);
  /** Tab clicks set activePaperId immediately; block URL sync from reverting until navigation lands. */
  const pendingNavRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document !== "undefined" && document.fullscreenElement && !focusMode) {
      setFocusMode(true);
    }
  }, [activePaperId, focusMode, setFocusMode]);

  useEffect(() => {
    if (paper?.id && paper.id === paperId) {
      recordPaperOpened(paper.id);
    }
  }, [paper?.id, paperId]);

  useEffect(() => {
    const pending = pendingNavRef.current;
    if (pending !== null) {
      // Optimistic tab switch in flight — ignore stale URL until it catches up.
      if (paperId === pending) {
        pendingNavRef.current = null;
        const nextCache =
          useStore.getState().papersById[paperId]?.cached_analysis ?? {};
        syncAutoAnalyzeGuardsFromCache(paperId, nextCache, nextCache);
        if (activePaperId !== paperId) {
          setActivePaperId(paperId);
        }
      }
      return;
    }
    if (paperId !== activePaperId) {
      // External navigation (library link, browser back) — URL is source of truth.
      const nextCache =
        useStore.getState().papersById[paperId]?.cached_analysis ?? {};
      syncAutoAnalyzeGuardsFromCache(paperId, nextCache, nextCache);
      setActivePaperId(paperId);
    }
  }, [paperId, activePaperId]);
  const panelPos = uiPrefs.panelPos as PanelPosition;
  const panelSize = panelPos === "bottom" ? uiPrefs.panelSizeBottom : uiPrefs.panelSizeSide;
  const setPanelPos = setPanelPosition;
  const setPanelSize = useCallback((size: number) => {
    const bounded = panelPos === "bottom"
      ? Math.min(MAX_BOTTOM, Math.max(MIN_BOTTOM, size))
      : Math.min(MAX_SIDE, Math.max(MIN_SIDE, size));
    setStoredPanelSize(panelPos, bounded);
  }, [panelPos, setStoredPanelSize]);
  const dragging = useRef(false);
  const startCoord = useRef(0);
  const startSize = useRef(0);

  const [selection, setSelection] = useState<{
    text: string;
    rect: DOMRect;
    regions?: Array<{
      pageNum: number;
      xPct: number;
      yPct: number;
      wPct: number;
      hPct: number;
    }>;
    hasMath?: boolean;
  } | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [folderInput, setFolderInput] = useState("");
  const [showAddPaper, setShowAddPaper] = useState(false);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [savedWorkspaces, setSavedWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string | null>(null);
  const [workspaceTruncation, setWorkspaceTruncation] = useState<{
    workspace: WorkspaceRecord;
    loaded: LoadedWorkspacePaper[];
    requested: number;
    missingCount: number;
  } | null>(null);

  const sessionIds = useMemo(() => new Set(sessionPapers.map((p) => p.id)), [sessionPapers]);

  const isActivePinned = useMemo(
    () => sessionPapers.some((p) => p.id === activePaperId),
    [sessionPapers, activePaperId],
  );
  const workspaceFull = sessionPapers.length >= MAX_SESSION_PAPERS;
  const showUnpinnedBanner =
    canMultiPaper &&
    !workspaceFeaturesComingSoon &&
    !workspaceTruncation &&
    !!activePaperId &&
    !isActivePinned &&
    workspaceFull;

  useEffect(() => {
    api.listPapers().then((papers) => {
      const folders = [...new Set(papers.map((p) => p.folder).filter(Boolean))].sort();
      setAllFolders(folders);
    }).catch(() => {});
  }, []);

  // Register the URL paper as the first session paper
  useEffect(() => {
    if (!paper?.id || paper.id !== paperId) return;
    addSessionPaper({ id: paper.id, title: paper.title });
  }, [paper?.id, paper?.title, paperId, addSessionPaper]);

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

  // Tracks the previous `focusMode` value so we only call `exitFullscreen`
  // when the user turns focus mode *off*, not on every mount with
  // `focusMode === false`. Otherwise navigating from the dashboard in
  // browser fullscreen would immediately exit fullscreen (this effect
  // used to treat "not in focus mode" as "must not be fullscreen").
  const prevFocusModeForFullscreenRef = useRef<boolean | null>(null);

  // Focus mode / fullscreen wiring. Two things happen here:
  //   1. When focusMode flips on we request browser fullscreen so the OS
  //      chrome (tabs, address bar, dock) also gets out of the way.
  //      Fullscreen can't be entered passively — it requires an active
  //      user gesture — so we only *attempt* it and ignore failures so
  //      non-user-initiated toggles (e.g. rehydrated from storage) still
  //      work as a soft focus state.
  //   2. Escape is handled globally so the user can bail out of either
  //      focus mode or hidden-header mode without hunting for a button.
  //      The browser also fires `fullscreenchange` when the user hits
  //      its own Esc — we listen for that too so our store stays in sync
  //      with the actual fullscreen state.
  useEffect(() => {
    const el = document.documentElement;
    if (focusMode) {
      if (!document.fullscreenElement && el.requestFullscreen) {
        el.requestFullscreen().catch(() => { /* best-effort */ });
      }
    } else if (
      prevFocusModeForFullscreenRef.current === true &&
      document.fullscreenElement &&
      document.exitFullscreen
    ) {
      document.exitFullscreen().catch(() => { /* ignore */ });
    }
    prevFocusModeForFullscreenRef.current = focusMode;
  }, [focusMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't hijack Escape while the user is dismissing dropdowns,
      // typing in inputs, or interacting with any open modal.
      if (showAddPaper || showFolderPicker || showWorkspaceMenu) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (focusMode) {
        e.preventDefault();
        setFocusMode(false);
      } else if (headerHidden) {
        e.preventDefault();
        setHeaderHidden(false);
      }
    };
    const onFsChange = () => {
      // Browser (or OS) yanked us out of fullscreen — reflect that in
      // our store so the toggle button shows the correct state.
      if (!document.fullscreenElement && focusMode) setFocusMode(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, [focusMode, headerHidden, setFocusMode, setHeaderHidden, showAddPaper, showFolderPicker, showWorkspaceMenu]);

  useEffect(() => {
    if (!activePaperId) return;

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
    } else {
      setPaper(null);
      setLoading(true);
    }

    // Track B1: skip the network call when we have a fresh cached copy.
    // The freshness gate is invalidated by mutators (title, folder,
    // re-extract) so edits still see fresh data on the next switch.
    if (cached && isPaperFresh(activePaperId)) {
      return () => { stale = true; };
    }

    api
      .getPaper(activePaperId)
      .then((p) => {
        if (stale) return;
        const merged = mergeCachedAnalysis(p, useStore.getState().papersById[activePaperId]);
        setPaper(merged);
        cachePaper(merged);
        markPaperFetched(activePaperId);
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

  const loadedPaperId = paper?.id;
  const loadedPaperCache = paper?.cached_analysis;
  const loadedPaperNotes = paper?.notes;

  // Rehydrate whenever the merged server cache meaningfully updates.
  // A one-shot ref-based guard missed second-pass `getPaper` payloads
  // (dashboard → reopen) and left the analysis slices empty until refresh.
  const cacheHydrateSig = useMemo(() => {
    const c = loadedPaperCache;
    const n = loadedPaperNotes;
    if (!loadedPaperId || loadedPaperId !== activePaperId) return "";
    const qaItemCount =
      Array.isArray(c?.qa_sessions)
        ? (c!.qa_sessions as { items?: { question: string; answer: string }[] }[]).reduce(
            (acc, s) => acc + (s.items?.length ?? 0),
            0,
          )
        : 0;
    const figCount = Array.isArray(c?.figure_analyses) ? c!.figure_analyses!.length : 0;
    let summaryBytes = 0;
    let preReadBytes = 0;
    if (c?.summary != null && typeof c.summary === "object") {
      try {
        summaryBytes = JSON.stringify(c.summary).length;
      } catch {
        summaryBytes = 1;
      }
    }
    if (c?.pre_reading != null && typeof c.pre_reading === "object") {
      try {
        preReadBytes = JSON.stringify(c.pre_reading).length;
      } catch {
        preReadBytes = 1;
      }
    }
    return [
      loadedPaperId,
      preReadBytes,
      summaryBytes,
      c?.selections?.length ?? 0,
      c?.qa_sessions?.length ?? 0,
      qaItemCount,
      c?.assumptions?.assumptions?.length ?? 0,
      figCount,
      n?.length ?? 0,
    ].join("|");
  }, [loadedPaperId, activePaperId, loadedPaperCache, loadedPaperNotes]);

  const hydrateFromCachedAnalysis = useCallback(
    (cache: NonNullable<typeof paper>["cached_analysis"], notes: NonNullable<typeof paper>["notes"]) => {
      if (!loadedPaperId) return;
      const pid = loadedPaperId;
      const snap = useStore.getState();

      // Notes: merge additively so locally-added notes (not yet flushed
      // into parsedPaper.notes) survive a server refetch.
      if (notes) {
        const existing = snap.notesByPaper[pid] ?? [];
        const ids = new Set(notes.map((n) => n.id));
        const onlyLocal = existing.filter((n) => !ids.has(n.id));
        const merged = [...notes, ...onlyLocal];
        merged.sort((a, b) => {
          const d = Number(a.created_at) - Number(b.created_at);
          return d !== 0 ? d : a.id.localeCompare(b.id);
        });
        const unchanged =
          merged.length === existing.length &&
          merged.every((n, i) => n.id === existing[i]?.id);
        if (!unchanged) {
          useStore.setState((s) => ({
            notesByPaper: { ...s.notesByPaper, [pid]: merged },
          }));
        }
      }

      // Selections: additive merge per F-HYDRATION §11.3.
      if (Array.isArray(cache.selections)) {
        const serverSelections = cache.selections as SelectionAnalysisResult[];
        const serverNewestFirst = [...serverSelections].reverse();
        const live = snap.selectionHistoryByPaper[pid] ?? [];
        const liveKeys = new Set(live.map(selectionKey));
        const additions = serverNewestFirst.filter((s) => !liveKeys.has(selectionKey(s)));
        if (additions.length > 0) {
          const merged = [...live, ...additions].slice(0, 50);
          useStore.setState((s) => ({
            selectionHistoryByPaper: {
              ...s.selectionHistoryByPaper,
              [pid]: merged,
            },
            selectionResultByPaper:
              !s.selectionResultByPaper[pid] && !s.selectionLoadingByPaper[pid]
                ? { ...s.selectionResultByPaper, [pid]: merged[0] ?? null }
                : s.selectionResultByPaper,
          }));
        }
      }

      // Summary: lite + deep + legacy `summary` shallow-merge into per-paper slot.
      const liteCached = (cache.summary_lite ?? null) as PaperSummary | null;
      const deepCached = (cache.summary_deep ?? null) as PaperSummary | null;
      const legacyCached = (cache.summary ?? null) as PaperSummary | null;
      const merged =
        liteCached || deepCached || legacyCached
          ? ({
              ...(legacyCached ?? {}),
              ...(deepCached ?? {}),
              ...(liteCached ?? {}),
            } as PaperSummary)
          : null;
      const isSummaryLoading = snap.summaryLoadingByPaper[pid] ?? false;
      const currentSummary = snap.summaryByPaper[pid] ?? null;
      if (merged && !isSummaryLoading) {
        const mergedJson = JSON.stringify(merged);
        const currentJson = currentSummary ? JSON.stringify(currentSummary) : "";
        if (mergedJson !== currentJson) {
          useStore.getState().setSummaryForPaper(pid, merged);
        }
      }

      if (cache.qa_sessions && cache.qa_sessions.length > 0) {
        const allItems = cache.qa_sessions.flatMap(
          (session: { items?: { question: string; answer: string }[] }) => session.items || [],
        );
        const liveQa = snap.qaResultsByPaper[pid] ?? [];
        // Server cache can lag behind in-session answers — never replace a
        // longer live list with a shorter stale hydrate payload.
        if (liveQa.length > allItems.length) return;
        const qaSame =
          liveQa.length === allItems.length &&
          liveQa.every((item, i) => item.question === allItems[i]?.question);
        if (!qaSame) {
          useStore.getState().setQAResultsForPaper(pid, allItems);
        }
      }

      const isPreLoading = snap.preReadingLoadingByPaper[pid] ?? false;
      const livePre = snap.preReadingByPaper[pid] ?? null;
      if (
        !isPreLoading &&
        isPreReadingPopulated(cache.pre_reading) &&
        JSON.stringify(livePre) !== JSON.stringify(cache.pre_reading)
      ) {
        setPreReadingForPaper(pid, cache.pre_reading);
      }

      const serverAssumptions = Array.isArray(cache.assumptions?.assumptions)
        ? cache.assumptions.assumptions
        : null;
      const liveAssumptions = snap.assumptionsByPaper[pid] ?? [];
      if (
        serverAssumptions &&
        serverAssumptions.length > 0 &&
        (liveAssumptions.length !== serverAssumptions.length ||
          JSON.stringify(liveAssumptions) !== JSON.stringify(serverAssumptions))
      ) {
        setAssumptionsForPaper(pid, serverAssumptions);
      }
    },
    [loadedPaperId, setAssumptionsForPaper, setPreReadingForPaper],
  );

  useEffect(() => {
    if (!loadedPaperId || loadedPaperId !== activePaperId) return;
    if (!cacheHydrateSig) return;
    const live = useStore.getState().paper;
    if (!live || live.id !== activePaperId) return;
    hydrateFromCachedAnalysis(live.cached_analysis || {}, live.notes || []);
    // Keyed on cacheHydrateSig only — not `loadedPaperCache` refs (React #185).
  }, [loadedPaperId, activePaperId, cacheHydrateSig, hydrateFromCachedAnalysis]);

  useEffect(() => {
    if (!loadedPaperId || loadedPaperId !== activePaperId || tierLoading) return;

    const pid = activePaperId;
    const livePaper = useStore.getState().paper;
    const cache =
      (livePaper?.id === pid ? livePaper.cached_analysis : null) ||
      useStore.getState().papersById[pid]?.cached_analysis ||
      {};
    const sessionCache = useStore.getState().papersById[pid]?.cached_analysis || {};
    syncAutoAnalyzeGuardsFromCache(pid, cache, sessionCache);
    const storeSnap = useStore.getState();
    const liveAssumptionsSlot = storeSnap.assumptionsByPaper[pid] ?? [];
    const cachedAssumptions =
      getCachedAssumptionItems(cache) ?? getCachedAssumptionItems(sessionCache);
    if (cachedAssumptions && liveAssumptionsSlot.length === 0) {
      setAssumptionsForPaper(pid, cachedAssumptions);
    }
    const assumptionsCoolingDown = assumptionsCooldownActive(cache, sessionCache);
    const hasPreReading =
      isPreReadingPopulated(cache.pre_reading) ||
      isPreReadingPopulated(sessionCache.pre_reading) ||
      isPreReadingPopulated(storeSnap.preReadingByPaper[pid] ?? null);
    const preReadingCooldownUntil = preReadingAutoRetryCooldownUntil.get(pid) ?? 0;
    const preReadingCoolingDown = Date.now() < preReadingCooldownUntil;

    if (
      !hasPreReading &&
      !preReadingCoolingDown &&
      canAccess(tierUser?.tier || "free", "prepare") &&
      !hasActiveRequest(pid, "preReading") &&
      !autoAnalyzedPapers.has(`${pid}:preReading`)
    ) {
      markRequestStart(pid, "preReading");
      setPreReadingLoadingForPaper(pid, true);
      api
        .analyze(pid)
        .then((r) => {
          // Per-paper writes — safe even if the user has switched away.
          useStore.getState().setPreReadingForPaper(pid, r);
          useStore.getState().updateCachedAnalysis(pid, { pre_reading: r });
          useStore.getState().setPreReadingError(pid, null);
          autoAnalyzedPapers.add(`${pid}:preReading`);
        })
        .catch((err) => {
          const msg =
            err instanceof Error ? err.message : "Prepare failed. Try again.";
          useStore.getState().setPreReadingError(pid, msg);
          autoAnalyzedPapers.delete(`${pid}:preReading`);
          preReadingAutoRetryCooldownUntil.set(pid, Date.now() + 30_000);
        })
        .finally(() => {
          markRequestEnd(pid, "preReading");
          clearProgressStart(pid, "preReading");
          setPreReadingLoadingForPaper(pid, false);
        });
    }

    const sessionAssumptions = Array.isArray(sessionCache.assumptions?.assumptions)
      ? sessionCache.assumptions.assumptions
      : null;
    const cacheHasAssumptionsKey = cache.assumptions !== undefined;
    const cacheNonEmpty = (cache.assumptions?.assumptions?.length ?? 0) > 0;
    const liveAssumptions = useStore.getState().assumptionsByPaper[pid] ?? [];
    const hasUsableAssumptions =
      cacheNonEmpty ||
      (sessionAssumptions && sessionAssumptions.length > 0) ||
      liveAssumptions.length > 0;
    if (cacheHasAssumptionsKey && !cacheNonEmpty) {
      autoAnalyzedPapers.add(`${pid}:assumptions`);
    }
    if (
      !hasUsableAssumptions &&
      !assumptionsCoolingDown &&
      canAccess(tierUser?.tier || "free", "assumptions") &&
      !hasActiveRequest(pid, "assumptions") &&
      !autoAnalyzedPapers.has(`${pid}:assumptions`) &&
      assumptionsKickoffForRef.current !== pid
    ) {
      assumptionsKickoffForRef.current = pid;
      markRequestStart(pid, "assumptions");
      setAssumptionsLoadingForPaper(pid, true);
      useStore.getState().setAssumptionsError(pid, null);
      api
        .getAssumptions(pid)
        .then((r) => {
          setAssumptionsForPaper(pid, r.assumptions);
          useStore.getState().updateCachedAnalysis(pid, {
            assumptions: { assumptions: r.assumptions },
          });
          useStore.getState().setAssumptionsError(pid, null);
          autoAnalyzedPapers.add(`${pid}:assumptions`);
        })
        .catch((err) => {
          markAssumptionsAttemptFailed(
            pid,
            useStore.getState().updateCachedAnalysis,
          );
          const msg =
            err instanceof Error
              ? err.message
              : "Extraction failed. Please try again.";
          useStore.getState().setAssumptionsError(pid, msg);
        })
        .finally(() => {
          markRequestEnd(pid, "assumptions");
          clearProgressStart(pid, "assumptions");
          setAssumptionsLoadingForPaper(pid, false);
        });
    } else if (hasUsableAssumptions || assumptionsCoolingDown) {
      assumptionsKickoffForRef.current = null;
    }

    const liveSummary = useStore.getState().summaryByPaper[pid] ?? null;
    const hasSummary = !!(
      cache.summary ||
      cache.summary_lite ||
      cache.summary_deep ||
      sessionCache.summary ||
      sessionCache.summary_lite ||
      sessionCache.summary_deep ||
      liveSummary
    );
    if (
      !hasSummary &&
      canAccess(tierUser?.tier || "free", "summary") &&
      !hasActiveRequest(pid, "summary") &&
      !autoAnalyzedPapers.has(`${pid}:summary`)
    ) {
      if (summaryKickoffForRef.current !== pid) {
        summaryKickoffForRef.current = pid;
        kickoffSummaryStream(pid);
      }
    } else {
      summaryKickoffForRef.current = null;
    }
  }, [
    loadedPaperId,
    activePaperId,
    cacheHydrateSig,
    tierLoading,
    tierUser?.tier,
    setPreReadingForPaper,
    setPreReadingLoadingForPaper,
    setAssumptionsForPaper,
    setAssumptionsLoadingForPaper,
    setSummaryLoadingForPaper,
  ]);

  const prefetchSessionPaper = useCallback((id: string) => {
    if (!id || id === activePaperId) return;
    if (useStore.getState().papersById[id] && isPaperFresh(id)) return;
    if (isPaperFresh(id)) return;
    void api
      .getPaper(id)
      .then((p) => {
        useStore.getState().cachePaper(p);
        markPaperFetched(id);
      })
      .catch(() => {});
  }, [activePaperId]);

  const handleSwitchPaper = useCallback((id: string) => {
    if (id === activePaperId && id === paperId) return;
    // Track A+B: per-paper state means no global reset on switch, and
    // streams for the previous paper keep running into their own slot.
    // We only sync auto-analyze guards so a paper whose first-pass
    // Prepare quietly failed can retry on re-entry.
    setSelection(null);
    const nextCache = useStore.getState().papersById[id]?.cached_analysis ?? {};
    syncAutoAnalyzeGuardsFromCache(id, nextCache, nextCache);
    setActivePaperId(id);
    // Keep the URL in sync. `router.replace` (not `push`) avoids
    // polluting history on every tab click — browser back skips over
    // tabs and returns to whatever was open before the workspace.
    if (typeof window !== "undefined" && id !== paperId) {
      pendingNavRef.current = id;
      router.replace(`/paper/${id}`);
    } else {
      pendingNavRef.current = null;
    }
  }, [activePaperId, paperId, router]);

  const handleAddPaper = useCallback((id: string, title: string) => {
    // Register the paper in the multi-paper session tab bar…
    const added = addSessionPaper({ id, title });
    if (!added) {
      // Workspace is full — surface the limit and don't navigate.
      // The popover stays open so the user can see the message.
      setError(WORKSPACE_PAPER_LIMIT_MESSAGE);
      return;
    }
    // …and open it. Track C1: use `router.push` (not `replace`) so the
    // browser back button returns to the previous paper — that closes
    // the "uploaded paper didn't load" loop where users hit back, saw
    // nothing happen, and assumed the upload silently failed.
    if (id !== activePaperId) {
      const nextCache = useStore.getState().papersById[id]?.cached_analysis ?? {};
      syncAutoAnalyzeGuardsFromCache(id, nextCache, nextCache);
      setActivePaperId(id);
      pendingNavRef.current = id;
      router.push(`/paper/${id}`);
    }
    setShowAddPaper(false);
  }, [addSessionPaper, activePaperId, router]);

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

  const handleRenameActivePaper = useCallback(async (next: string) => {
    if (!paper) return;
    const prev = paper.title;
    // Optimistic: flip the title across every in-memory surface
    // immediately so the nav bar, session tabs, and cached listings
    // all reflect the rename without waiting on the server.
    updatePaperTitle(paper.id, next);
    try {
      const res = await api.updateTitle(paper.id, next);
      // The server may have sanitized the title (whitespace collapse,
      // length cap). Reconcile so what the user sees matches what
      // persists across reloads.
      if (res?.title && res.title !== next) {
        updatePaperTitle(paper.id, res.title);
      }
    } catch {
      // Roll back on failure so the UI doesn't show a rename the
      // server never accepted.
      updatePaperTitle(paper.id, prev);
    }
  }, [paper, updatePaperTitle]);

  const handleSaveWorkspace = useCallback(async () => {
    const name = workspaceNameInput.trim() || `Session · ${sessionPapers.length} papers`;
    setWorkspaceSaving(true);
    setWorkspaceSaved(false);
    try {
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
  }, [workspaceNameInput, sessionPapers, crossPaperResults]);

  const finalizeWorkspaceLoad = useCallback(
    (
      papers: { id: string; title: string }[],
      ws: WorkspaceRecord,
      missingCount: number,
    ) => {
      applyWorkspaceSession(papers, ws.cross_paper_results, {
        clearWorkspaceSession,
        clearCrossPaperResults,
        addCrossPaperResults,
        addSessionPaper,
      });
      const firstId = papers[0].id;
      setActivePaperId(firstId);
      if (firstId !== paperId) {
        pendingNavRef.current = firstId;
        router.push(`/paper/${firstId}`);
      } else {
        pendingNavRef.current = null;
      }
      setShowWorkspaceMenu(false);
      setActiveWorkspaceName(
        missingCount > 0 ? `${ws.name} (${missingCount} missing)` : ws.name,
      );
      setWorkspaceTruncation(null);
    },
    [
      clearWorkspaceSession,
      clearCrossPaperResults,
      addCrossPaperResults,
      addSessionPaper,
      paperId,
      router,
    ],
  );

  const handleLoadWorkspace = useCallback(
    async (ws: WorkspaceRecord) => {
      const requested = ws.paper_ids.length;
      const { loaded, missingCount } = await resolveWorkspacePapers(ws.paper_ids);

      if (loaded.length === 0) {
        setError(
          "This workspace can't be opened — every paper it references has been deleted.",
        );
        setShowWorkspaceMenu(false);
        return;
      }

      const willDrop = Math.max(0, loaded.length - MAX_SESSION_PAPERS);
      if (willDrop > 0) {
        const remembered = getRememberedWorkspacePapers(ws, loaded);
        if (remembered) {
          finalizeWorkspaceLoad(remembered, ws, missingCount);
          return;
        }
        setWorkspaceTruncation({ workspace: ws, loaded, requested, missingCount });
        setShowWorkspaceMenu(false);
        return;
      }

      finalizeWorkspaceLoad(loaded, ws, missingCount);
    },
    [finalizeWorkspaceLoad],
  );

  const handlePinSwap = useCallback(
    (droppedId: string) => {
      removeSessionPaper(droppedId);
      addSessionPaper({ id: activePaperId, title: paper?.title ?? "Untitled" });
    },
    [removeSessionPaper, addSessionPaper, activePaperId, paper?.title],
  );

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

  // Multi-paper citation flow: when the user hits the header Citations
  // button in a workspace (i.e. 2+ papers loaded), we pop a picker so
  // they can scope the export. Single-paper sessions skip the picker
  // and export directly for the paper they're reading.
  const [citationScopeOpen, setCitationScopeOpen] = useState(false);
  const handleCitationButton = useCallback(() => {
    if (sessionPapers.length <= 1) {
      handleExportBibtex(
        { paper_ids: [activePaperId] },
        (paper?.title ? paper.title : "Current paper"),
      );
      return;
    }
    setCitationScopeOpen(true);
  }, [sessionPapers, activePaperId, paper, handleExportBibtex]);

  const [paperUsage, setPaperUsage] = useState<{
    qa_used: number; qa_limit: number; selections_used: number; selections_limit: number;
  } | null>(null);

  const usageRefreshKey = useStore((s) => s.usageRefreshKey);

  const refreshUsage = useCallback(() => {
    api.getPaperUsage(activePaperId).then(setPaperUsage).catch(() => {});
  }, [activePaperId]);

  useEffect(() => { refreshUsage(); }, [refreshUsage, usageRefreshKey]);

  useEffect(() => {
    if (!activePaperId) return;
    let cancelled = false;
    const epochAtStart =
      useStore.getState().highlightsFetchEpochByPaper[activePaperId] ?? 0;
    void api
      .listHighlights(activePaperId)
      .then((res) => {
        if (cancelled) return;
        if (
          (useStore.getState().highlightsFetchEpochByPaper[activePaperId] ?? 0) !==
          epochAtStart
        ) {
          return;
        }
        useStore.getState().setHighlightsForPaper(activePaperId, res.items ?? []);
      })
      .catch(() => { /* highlights are best-effort hydration */ });
    return () => { cancelled = true; };
  }, [activePaperId]);

  // Restore last-read tab + page. Idempotent: if the user has already
  // clicked another tab in the ~200 ms it takes to hydrate, do nothing.
  const restoredTabForPaperRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activePaperId) return;
    if (restoredTabForPaperRef.current === activePaperId) return;
    let cancelled = false;
    void api.getReadingState(activePaperId).then((row) => {
      if (cancelled || !row) return;
      if (restoredTabForPaperRef.current === activePaperId) return;
      restoredTabForPaperRef.current = activePaperId;
      useStore.getState().setReadingStateForPaper(activePaperId, {
        last_page: row.last_page,
        last_tab: row.last_tab,
        scroll_pct: row.scroll_pct,
      });
      const currentTab = useStore.getState().activeTab;
      // Only restore when the user hasn't picked a tab yet this session.
      // Store default is "summary"; treat summary/prepare as untouched.
      const untouched = currentTab === "summary" || currentTab === "prepare";
      if (row.last_tab && untouched && row.last_tab !== currentTab) {
        useStore.getState().setActiveTab(row.last_tab);
      }
    }).catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [activePaperId]);

  const handleTextSelected = useCallback((
    text: string,
    rect: DOMRect,
    capture?: {
      regions?: Array<{ pageNum: number; xPct: number; yPct: number; wPct: number; hPct: number }>;
      hasMath?: boolean;
    },
  ) => {
    setSelection({ text, rect, regions: capture?.regions, hasMath: capture?.hasMath });
  }, []);

  const handleSelectionClear = useCallback(() => {
    setSelection(null);
  }, []);

  const handleSelectionAction = useCallback(async (
    action: SelectionAction,
    text: string,
    meta?: { highlightColor?: string },
  ) => {
    const capturedRegions = selection?.regions;
    setSelection(null);
    window.getSelection()?.removeAllRanges();

    // Capture the paper this action was started for. Every state write
    // below must verify the user is still viewing this paper — otherwise
    // a slow "Derive" on paper A could repaint the analysis pane for
    // paper B once the user switches.
    const startedFor = activePaperId;

    if (action === "highlight") {
      if (!startedFor) return;
      const color = meta?.highlightColor ?? "yellow";
      const regions = capturedRegions;
      try {
        const row = await api.createHighlight(startedFor, {
          selected_text: text,
          color,
        });
        useStore.getState().addHighlightForPaper(startedFor, row);
        if (regions?.length) {
          useStore.getState().addPdfRegionHighlightsForHighlight(
            startedFor,
            row.id,
            color as "yellow" | "green" | "blue" | "pink",
            regions,
          );
        }
      } catch (e) {
        console.error("Failed to save highlight:", e);
      }
      return;
    }

    if (action === "note") {
      setPanelVisible(true);
      setActiveTab("notes");
      const pendingId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `pending-note-${crypto.randomUUID()}`
          : `pending-note-${Date.now()}`;
      const provisionalNote = {
        id: pendingId,
        text,
        section: "PDF Selection",
        created_at: Math.floor(Date.now() / 1000),
      };
      useStore.getState().addNoteForPaper(startedFor, provisionalNote);

      try {
        const note = await api.addNote(startedFor, text, "PDF Selection", true);
        // Per-paper writes — safe even if the user has switched away.
        useStore.setState((s) => ({
          notesByPaper: {
            ...s.notesByPaper,
            [startedFor]: (s.notesByPaper[startedFor] ?? []).map((n) =>
              n.id === pendingId ? note : n,
            ),
          },
        }));
        setSelectionResultForPaper(startedFor, null);
        upsertSelectionInHistoryForPaper(startedFor, {
          action: "note",
          selected_text: text,
          explanation: note.text,
          streaming: false,
          clientKey: note.id,
        });
      } catch (e) {
        console.error("Failed to save note:", e);
        useStore.getState().removeNoteForPaper(startedFor, pendingId);
      }
      return;
    }

    // Streaming actions — explain / derive — go through the migrated
    // Next.js + AI SDK route. `selectionThread` is constructed with
    // `activePaperId`, so its writes are already paper-scoped; no
    // extra guard required.
    if (!startedFor) return;
    setPanelVisible(true);
    setActiveTab("selection");

    selectionThread.start({
      action: action as "explain" | "derive",
      selectedText: text,
    });
  }, [activePaperId, selection, setPanelVisible, setActiveTab, selectionThread, setSelectionResultForPaper, upsertSelectionInHistoryForPaper]);

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
    [panelPos, setPanelSize]
  );

  const onDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const cyclePosition = useCallback(() => {
    const idx = POSITIONS.indexOf(panelPos);
    const next = POSITIONS[(idx + 1) % POSITIONS.length];
    setPanelPos(next);
    setPanelSize(next === "bottom" ? uiPrefs.panelSizeBottom : uiPrefs.panelSizeSide);
  }, [panelPos, setPanelPos, setPanelSize, uiPrefs.panelSizeBottom, uiPrefs.panelSizeSide]);

  if (loading) {
    return (
      <PaperLoadingScreen
        title="Opening paper"
        subtitle="Loading PDF and saved analysis…"
        detail={paper?.title ? paper.title.slice(0, 72) : undefined}
      />
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
        // `overflow-hidden` is load-bearing here: without it the child
        // tab bar's opaque background paints a full rectangle that pokes
        // through the rounded corners of the wrapper, making the top of
        // the pane look like a white square stapled onto the rounded
        // border. Clipping the child to the wrapper's shape makes the
        // curved corners actually show.
        //
        // `bg-background` (solid, not the previous /80) means PDF page
        // content can never bleed through when the pane floats above
        // the reader column in focus mode — images especially were
        // showing through the translucent tint, which read as a bug.
        isBottom ? "mx-auto max-w-3xl border-l border-r border-t border-border rounded-t-xl overflow-hidden bg-background" : ""
      }`}
    >
      <AnalysisPanel
        paperId={activePaperId}
        position={panelPos}
        onCyclePosition={cyclePosition}
        selectionThread={selectionThread}
      />
    </div>
  );

  const pdfInner = (
    <>
      {useMarkdownReader ? (
        <MarkdownReader
          paperId={activePaperId}
          onTextSelected={handleTextSelected}
          onSelectionClear={handleSelectionClear}
        />
      ) : (
        <PdfViewer
          url={api.getPdfUrl(activePaperId)}
          paperId={activePaperId}
          onTextSelected={handleTextSelected}
          onSelectionClear={handleSelectionClear}
          reserveToolbarRightForOverlay={headerHidden && !focusMode}
        />
      )}
      {selection && (
        <SelectionToolbar
          text={selection.text}
          rect={selection.rect}
          hasMath={selection.hasMath ?? false}
          onAction={handleSelectionAction}
          onDismiss={handleSelectionClear}
        />
      )}
    </>
  );

  const showSessionBar =
    canMultiPaper &&
    !workspaceFeaturesComingSoon &&
    sessionPapers.length > 1;

  return (
    <>
    <KeyboardShortcuts />
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header — hidden in focus mode or when the user explicitly
          collapses the top bar. Keeping the element mounted would still
          reserve its 48px, so we drop it from the tree entirely and rely
          on the floating restore control below to bring it back. */}
      {!chromeHidden && (
      <header className="relative z-30 flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 px-4 shadow-sm glass-nav">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-muted-foreground/80 hover:text-foreground transition-colors shrink-0 ring-focus rounded-md p-1 -ml-1"
          aria-label="Back to dashboard"
          title="Back to dashboard"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </button>
        <Image src="/logo.png" alt="Know" width={18} height={18} className="shrink-0 rounded-md opacity-90" />
        <div className="h-3.5 w-px bg-border/70 shrink-0 mx-0.5" />

        {!showSessionBar && (
          <div className="flex-1 min-w-0 flex items-center">
            <EditableTitle
              value={paper.title}
              onCommit={handleRenameActivePaper}
              className="text-[13px] text-foreground font-medium tracking-[-0.005em] truncate max-w-full"
            />
          </div>
        )}

        {showSessionBar && (
          <span className="text-[10.5px] text-muted-foreground/70 truncate flex-1 font-semibold uppercase tracking-[0.14em]">
            Session · {sessionPapers.length} papers
          </span>
        )}

        {/* Usage indicator — tightened visual treatment so it reads as
            a quiet status pill rather than a pair of floating labels.
            Tabular numerals keep the count from shifting horizontally
            as it ticks up. */}
        {paperUsage && paperUsage.qa_limit > 0 && (
          <div
            className="hidden sm:flex items-center gap-2 shrink-0 text-[10.5px] font-medium text-muted-foreground/80 tabular-nums rounded-full border border-border/70 bg-background/40 px-2.5 py-0.5"
            title={`Q&A ${paperUsage.qa_used}/${paperUsage.qa_limit} · Selections ${paperUsage.selections_used}/${paperUsage.selections_limit} on this paper`}
          >
            <span>Q&A {paperUsage.qa_used}/{paperUsage.qa_limit}</span>
            <span className="w-px h-2.5 bg-border/80" aria-hidden />
            <span>Sel {paperUsage.selections_used}/{paperUsage.selections_limit}</span>
          </div>
        )}

        {/* Add paper button */}
        {workspaceFeaturesComingSoon ? (
          <ComingSoonNavControl
            label="Add Paper"
            tooltip={WORKSPACE_FEATURES_COMING_SOON_TOOLTIP}
            icon={
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            }
          />
        ) : canMultiPaper ? (
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={() => { setShowFolderPicker(false); setShowWorkspaceMenu(false); setShowAddPaper(!showAddPaper); }}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground/90"
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
        ) : null}

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

        {/* Export citations. Singular label for a one-paper session,
            plural (with a scope picker) once the user has loaded a
            workspace so it's obvious the action covers more than just
            the paper currently in focus. */}
        {!isFree && (
        <button
          onClick={handleCitationButton}
          className="shrink-0 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground/90 px-2 py-1 rounded-md hover:bg-accent/60 transition-colors"
          title={sessionPapers.length > 1 ? "Export citations for session" : "Export citation for current paper"}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
          </svg>
          <span className="hidden sm:inline">
            {sessionPapers.length > 1 ? "Citations" : "Citation"}
          </span>
        </button>
        )}

        {/* Workspace save/load */}
        {workspaceFeaturesComingSoon ? (
          <ComingSoonNavControl
            label="Workspace"
            tooltip={WORKSPACE_FEATURES_COMING_SOON_TOOLTIP}
            icon={
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
              </svg>
            }
          />
        ) : canMultiPaper ? (
        <div className="relative shrink-0" data-dropdown>
          <button
            onClick={handleOpenWorkspaceMenu}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground/90"
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
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-xl btn-primary-glass text-white transition-opacity disabled:opacity-50 shrink-0"
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
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-muted-foreground transition-colors shrink-0"
                          title="Export BibTeX"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteWorkspace(ws.id); }}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-destructive transition-colors shrink-0"
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
        ) : null}

        <button
          onClick={togglePanel}
          className={`text-[12px] font-medium transition-colors shrink-0 ${
            panelVisible ? "text-foreground" : "text-muted-foreground hover:text-foreground/90"
          }`}
        >
          {panelVisible ? "Hide Analysis" : "Show Analysis"}
        </button>

        {useMarkdownReader && (
          <button
            type="button"
            onClick={() => window.open(api.getPdfUrl(activePaperId), "_blank", "noopener,noreferrer")}
            className="hidden sm:inline text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            View original PDF
          </button>
        )}

        {/* Focus mode: drop all chrome and request browser fullscreen.
            Escape exits. */}
        <button
          onClick={toggleFocusMode}
          className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors ring-focus rounded-md p-1"
          title={focusMode ? "Exit focus mode (Esc)" : "Focus mode"}
          aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0l5.25 5.25M20.25 3.75h-4.5m4.5 0v4.5m0-4.5l-5.25 5.25M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0l5.25-5.25m10.5 5.25h-4.5m4.5 0v-4.5m0 4.5l-5.25-5.25" />
          </svg>
        </button>

        <ThemeToggle />
        <UserButton
          appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }}
        >
          <UserButton.MenuItems>
            <UserButton.Link label="Settings" labelIcon={<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>} href="/settings" />
          </UserButton.MenuItems>
        </UserButton>
      </header>
      )}

      {showUnpinnedBanner && !chromeHidden && (
        <UnpinnedPaperBanner
          sessionPapers={sessionPapers}
          activePaperTitle={paper?.title ?? "Untitled"}
          onPinSwap={handlePinSwap}
        />
      )}

      {/* Session paper tabs */}
      {showSessionBar && !chromeHidden && (
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
                className={`group flex items-center rounded-full text-[11px] font-medium transition-colors shrink-0 ${
                  sp.id === activePaperId
                    ? "btn-primary-glass"
                    : "glass-subtle text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSwitchPaper(sp.id)}
                  onMouseEnter={() => prefetchSessionPaper(sp.id)}
                  onFocus={() => prefetchSessionPaper(sp.id)}
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
          // `relative z-20` + solid `bg-background` keeps the analysis
          // pane above the reader column's own stacking context, which
          // can be pushed forward by the PDF canvas (transforms) and
          // its overlays. Without this, figures and equations in the
          // reader column could be painted *over* the pane in focus
          // mode, which looked like a rendering bug.
          className={cn(
            "shrink-0 relative z-20 overflow-hidden",
            isBottom && "bg-background rounded-t-xl",
            !isBottom && chromeHidden && "border-l border-r border-t border-border bg-background",
            !isBottom && !chromeHidden && "know-reader-analysis-shell",
            !isBottom && !chromeHidden && panelPos === "right" && "know-reader-analysis-shell-right",
            !isBottom && !chromeHidden && panelPos === "left" && "know-reader-analysis-shell-left",
          )}
          style={{
            ...(isBottom ? { height: panelSize } : { width: panelSize }),
            order: panelPos === "left" ? 1 : 3,
            display: panelVisible ? undefined : "none",
          }}
        >
          {panelInner}
        </div>
      </div>

      {/* Floating restore affordance for when the top bar is hidden. We
          intentionally keep it small, translucent, and tucked into the
          top-right corner so it doesn't compete with the paper content,
          but stays discoverable for users who forget the Escape hotkey.
          Dedicated buttons (instead of a single "restore" action) let
          people exit focus mode without losing the underlying
          hide-navbar preference, and vice-versa. */}
      {/* Only surface the floating restore chip when the user has
          collapsed the top bar outside of focus mode. In focus mode
          itself the chip becomes visual noise — Escape is the natural
          exit and is already hinted to users when they toggle focus
          mode on. Showing a competing button there fights against the
          whole point of the mode, which is to get chrome out of the
          way. */}
      {headerHidden && !focusMode && (
        <div className="fixed top-2 right-2 z-40 flex items-center gap-1 glass-strong rounded-full px-1.5 py-1 shadow-sm animate-fade-in">
          <button
            onClick={() => { setHeaderHidden(false); }}
            className="text-muted-foreground/80 hover:text-foreground transition-colors rounded-full p-1 ring-focus"
            title="Show top bar"
            aria-label="Show top bar"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
        </div>
      )}

      {/* Focus-mode analysis-pane toggle. Both directions live on the
          same chip so the user can bring the pane back *and* hide it
          again without needing to leave focus mode — previously we
          only rendered the "Show" variant, which left people stuck
          once they'd opened the pane because the header with its
          regular controls is gone in focus mode. */}
      {focusMode && (
        <button
          onClick={() => setPanelVisible(!panelVisible)}
          className="fixed bottom-4 right-4 z-50 glass-strong rounded-full pl-3 pr-3.5 py-2 flex items-center gap-2 text-[12px] font-medium text-foreground/90 hover:text-foreground shadow-md hover:shadow-lg transition-shadow animate-fade-in ring-focus"
          title={panelVisible ? "Hide analysis pane" : "Open analysis pane"}
          aria-label={panelVisible ? "Hide analysis pane" : "Open analysis pane"}
          aria-pressed={panelVisible}
        >
          {panelVisible ? (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
            </svg>
          )}
          {panelVisible ? "Hide Analysis" : "Show Analysis"}
        </button>
      )}

      {/* Floating session paper switcher in focus mode. Hiding all
          chrome was great for reading a single paper, but left users
          unable to jump between multi-paper workspaces without
          exiting focus mode first. This reproduces the session tab
          UI as a compact, auto-fading top-center pill so it stays
          accessible without competing with the PDF content. */}
      {focusMode && showSessionBar && (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-40 max-w-[min(90vw,720px)] animate-fade-in">
          <div className="flex items-center gap-1 glass-strong rounded-full shadow-md px-1.5 py-1 overflow-x-auto scrollbar-hide">
            {sessionPapers.map((sp) => (
              <div
                key={sp.id}
                role="group"
                aria-label={sp.title}
                className={`group flex items-center rounded-full text-[11px] font-medium transition-colors shrink-0 ${
                  sp.id === activePaperId
                    ? "btn-primary-glass"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleSwitchPaper(sp.id)}
                  onMouseEnter={() => prefetchSessionPaper(sp.id)}
                  onFocus={() => prefetchSessionPaper(sp.id)}
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
    </div>

      <CitationScopeModal
        open={citationScopeOpen}
        onClose={() => setCitationScopeOpen(false)}
        papers={sessionPapers.map((p) => ({ id: p.id, title: p.title }))}
        activePaperId={activePaperId}
        workspaceName={activeWorkspaceName ?? null}
        onExport={(ids, label) => {
          setCitationScopeOpen(false);
          handleExportBibtex({ paper_ids: ids }, label);
        }}
      />

      <BibtexModal
        open={bibtexModal.open}
        onClose={() => setBibtexModal({ open: false })}
        paperIds={bibtexModal.paperIds}
        workspaceId={bibtexModal.workspaceId}
        label={bibtexModal.label}
      />

      {workspaceTruncation && (
        <WorkspaceTruncationModal
          open
          workspaceId={workspaceTruncation.workspace.id}
          workspaceUpdatedAt={workspaceTruncation.workspace.updated_at}
          requested={workspaceTruncation.requested}
          missingCount={workspaceTruncation.missingCount}
          cap={MAX_SESSION_PAPERS}
          papers={workspaceTruncation.loaded}
          onClose={() => setWorkspaceTruncation(null)}
          onConfirm={(selected) => {
            finalizeWorkspaceLoad(
              selected,
              workspaceTruncation.workspace,
              workspaceTruncation.missingCount,
            );
          }}
        />
      )}
    </>
  );
}

export default function PaperPage() {
  return <PaperContent />;
}
