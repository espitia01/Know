"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { api, PaperListEntry } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { BibtexModal } from "@/components/BibtexModal";
import { useUserTier, canAccess } from "@/lib/UserTierContext";

function FolderIcon({ className = "w-4 h-4", filled = false }: { className?: string; filled?: boolean }) {
  return filled ? (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.5 21a3 3 0 003-3v-4.5a3 3 0 00-3-3h-15a3 3 0 00-3 3V18a3 3 0 003 3h15zM1.5 10.146V6a3 3 0 013-3h5.379a2.25 2.25 0 011.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 013 3v1.146A4.483 4.483 0 0019.5 9h-15a4.483 4.483 0 00-3 1.146z" />
    </svg>
  ) : (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

function LibraryContent() {
  const router = useRouter();
  const { user: tierUser, loading: tierLoading } = useUserTier();
  const isFree = tierLoading ? true : (!tierUser || tierUser.tier === "free");
  const [papers, setPapers] = useState<PaperListEntry[]>([]);
  const [search, setSearch] = useState("");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [movingPaper, setMovingPaper] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = useState<string | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const dragPaper = useRef<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"folders" | "workspaces">("folders");
  const [fetchError, setFetchError] = useState("");
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; paper_ids: string[]; cross_paper_results: { question: string; answer: string }[]; updated_at: string }[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspacesFetched, setWorkspacesFetched] = useState(false);
  const [deleteWsConfirm, setDeleteWsConfirm] = useState<string | null>(null);
  const { addSessionPaper, clearSession, addCrossPaperResults, clearCrossPaperResults } = useStore();

  useEffect(() => {
    api.listPapers()
      .then(setPapers)
      .catch(() => setFetchError("Failed to load papers. Please refresh."));
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    try {
      const wsList = await api.listWorkspaces();
      setWorkspaces(wsList);
    } catch { /* ignore */ }
    setWorkspacesLoading(false);
    setWorkspacesFetched(true);
  }, []);

  useEffect(() => {
    if (sidebarTab === "workspaces" && !workspacesFetched && !workspacesLoading) {
      loadWorkspaces();
    }
  }, [sidebarTab, workspacesFetched, workspacesLoading, loadWorkspaces]);

  const handleOpenWorkspace = useCallback(async (ws: typeof workspaces[0]) => {
    clearSession();
    clearCrossPaperResults();
    if (ws.cross_paper_results?.length > 0) {
      addCrossPaperResults(ws.cross_paper_results);
    }
    for (const pid of ws.paper_ids) {
      try {
        const p = await api.getPaper(pid);
        addSessionPaper({ id: p.id, title: p.title });
      } catch { /* paper may have been deleted */ }
    }
    if (ws.paper_ids.length > 0) {
      router.push(`/paper/${ws.paper_ids[0]}`);
    }
  }, [clearSession, clearCrossPaperResults, addCrossPaperResults, addSessionPaper, router]);

  const handleDeleteWorkspace = useCallback(async (wsId: string) => {
    try {
      await api.deleteWorkspace(wsId);
      setWorkspaces((prev) => prev.filter((w) => w.id !== wsId));
    } catch { /* ignore */ }
    setDeleteWsConfirm(null);
  }, []);

  const allFolders = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => { if (p.folder) set.add(p.folder); });
    customFolders.forEach((f) => set.add(f));
    return [...set].sort();
  }, [papers, customFolders]);

  const filtered = useMemo(() => {
    let list = papers;
    if (activeFolder === "") {
      list = list.filter((p) => !p.folder);
    } else if (activeFolder) {
      list = list.filter((p) => p.folder === activeFolder);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.authors?.some((a) => a.toLowerCase().includes(q)) ||
          p.tags?.some((t) => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [papers, activeFolder, search]);

  const PAGE_SIZE = 50;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visiblePapers = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [filtered]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.deletePaper(id);
      setPapers((prev) => prev.filter((p) => p.id !== id));
    } catch (e) { console.error(e); }
    setDeleteConfirm(null);
  }, []);

  const handleMoveToFolder = useCallback(async (paperId: string, folder: string) => {
    try {
      await api.updateFolder(paperId, folder);
      setPapers((prev) =>
        prev.map((p) => (p.id === paperId ? { ...p, folder } : p))
      );
    } catch (e) { console.error(e); }
    setMovingPaper(null);
  }, []);

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (!allFolders.includes(name)) {
      setCustomFolders((prev) => [...prev, name]);
    }
    setNewFolderName("");
    setShowNewFolder(false);
    setActiveFolder(name);
  };

  const handleDeleteFolder = useCallback(async (folder: string) => {
    const papersInFolder = papers.filter((p) => p.folder === folder);
    try {
      for (const p of papersInFolder) {
        await api.updateFolder(p.id, "");
      }
      setPapers((prev) =>
        prev.map((p) => (p.folder === folder ? { ...p, folder: "" } : p))
      );
    } catch (e) { console.error(e); }
    setCustomFolders((prev) => prev.filter((f) => f !== folder));
    if (activeFolder === folder) setActiveFolder(null);
    setDeleteFolderConfirm(null);
  }, [papers, activeFolder]);

  const folderCount = (folder: string) =>
    papers.filter((p) => p.folder === folder).length;

  const [bibtexModal, setBibtexModal] = useState<{
    open: boolean;
    paperIds?: string[];
    folder?: string;
    workspaceId?: string;
    label?: string;
  }>({ open: false });

  const handleExportBibtex = useCallback((opts: { paper_ids?: string[]; folder?: string; workspace_id?: string }, label?: string) => {
    setBibtexModal({
      open: true,
      paperIds: opts.paper_ids,
      folder: opts.folder,
      workspaceId: opts.workspace_id,
      label: label || "Selected papers",
    });
  }, []);

  const onPaperDragStart = useCallback((e: React.DragEvent, paperId: string) => {
    dragPaper.current = paperId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", paperId);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.4";
    }
  }, []);

  const onPaperDragEnd = useCallback((e: React.DragEvent) => {
    dragPaper.current = null;
    setDragOverFolder(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  }, []);

  const onFolderDragOver = useCallback((e: React.DragEvent, folder: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverFolder(folder);
  }, []);

  const onFolderDragLeave = useCallback(() => {
    setDragOverFolder(null);
  }, []);

  const onFolderDrop = useCallback((e: React.DragEvent, folder: string) => {
    e.preventDefault();
    setDragOverFolder(null);
    const paperId = e.dataTransfer.getData("text/plain") || dragPaper.current;
    if (paperId) {
      handleMoveToFolder(paperId, folder);
    }
  }, [handleMoveToFolder]);

  return (
    <>
    <main className="flex-1 flex flex-col h-screen overflow-hidden bg-mesh">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-5 h-[52px] border-b border-black/[0.06] glass-nav z-30 relative">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-gray-500 hover:text-gray-700 transition-colors text-[13px] font-medium"
        >
          &larr;
        </button>
        <div className="h-4 w-px bg-gray-200" />
        <Image src="/logo.png" alt="Know" width={20} height={20} className="rounded-md" />
        <h1 className="text-[15px] font-semibold text-gray-900">Library</h1>
        <div className="flex-1" />
        <span className="text-[12px] text-gray-500 font-medium tabular-nums">
          {papers.length} paper{papers.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={() => {
            if (sidebarTab === "workspaces") return;
            const opts: { folder?: string; paper_ids?: string[] } = {};
            let lbl = "All papers";
            if (activeFolder !== null) {
              opts.folder = activeFolder;
              lbl = activeFolder ? `Folder: ${activeFolder}` : "Unfiled papers";
            } else {
              opts.paper_ids = filtered.map((p) => p.id);
            }
            handleExportBibtex(opts, lbl);
          }}
          disabled={filtered.length === 0 || isFree}
          className="text-[11px] text-gray-500 hover:text-gray-700 transition-colors font-medium px-2 py-1 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          title={isFree ? "Upgrade to export citations" : "Export Citations"}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
          </svg>
          Citations
        </button>
        <UserButton appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }} />
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 border-r border-black/[0.06] glass-subtle overflow-y-auto p-4 space-y-4">
          <Input
            placeholder="Search papers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="text-[13px] h-9 rounded-xl bg-white/50 border-black/[0.06] focus:border-white/40 backdrop-blur-sm"
          />

          {/* Sidebar tabs */}
          <div className="flex gap-1 glass-subtle rounded-xl p-0.5">
            <button
              onClick={() => setSidebarTab("folders")}
              className={`flex-1 text-[11px] font-semibold py-1.5 rounded-lg transition-all ${
                sidebarTab === "folders"
                  ? "glass-strong text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Folders
            </button>
            <button
              onClick={() => !isFree && setSidebarTab("workspaces")}
              disabled={isFree}
              className={`flex-1 text-[11px] font-semibold py-1.5 rounded-lg transition-all ${
                isFree
                  ? "text-gray-300 cursor-not-allowed"
                  : sidebarTab === "workspaces"
                  ? "glass-strong text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Workspaces{isFree ? " ⬆" : ""}
            </button>
          </div>

          {sidebarTab === "folders" ? (
            <>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400">
                Folders
              </p>
              <button
                onClick={() => setShowNewFolder(!showNewFolder)}
                className="w-5 h-5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 flex items-center justify-center transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </button>
            </div>

            {showNewFolder && (
              <div className="flex gap-1.5 animate-fade-in mb-3">
                <Input
                  placeholder="Folder name..."
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
                  className="text-[12px] h-8 flex-1 rounded-lg bg-white border-gray-100"
                  autoFocus
                />
                <button
                  onClick={handleCreateFolder}
                  className="text-[11px] text-gray-700 font-semibold px-2 hover:opacity-70 transition-opacity"
                >
                  Add
                </button>
              </div>
            )}

            <button
              onClick={() => setActiveFolder(null)}
              className={`w-full text-left text-[12px] px-3 py-2.5 rounded-xl transition-all duration-200 ${
                activeFolder === null
                  ? "bg-gradient-to-r from-gray-800 to-gray-900 text-white font-medium shadow-md shadow-gray-900/10"
                  : "text-gray-600 hover:text-gray-900 hover:bg-white/50"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <FolderIcon className="w-4 h-4 shrink-0" filled={activeFolder === null} />
                <span className="flex-1">All Papers</span>
                <span className="text-[10px] opacity-50 tabular-nums">{papers.length}</span>
              </span>
            </button>

            <button
              onClick={() => setActiveFolder("")}
              onDragOver={(e) => onFolderDragOver(e, "")}
              onDragLeave={onFolderDragLeave}
              onDrop={(e) => onFolderDrop(e, "")}
              className={`w-full text-left text-[12px] px-3 py-2.5 rounded-xl transition-all duration-200 ${
                dragOverFolder === ""
                  ? "bg-violet-50/50 ring-2 ring-violet-300/40 ring-inset"
                  : activeFolder === ""
                    ? "bg-gradient-to-r from-gray-800 to-gray-900 text-white font-medium shadow-md shadow-gray-900/10"
                    : "text-gray-600 hover:text-gray-900 hover:bg-white/50"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <span className="flex-1">Unfiled</span>
                <span className="text-[10px] opacity-50 tabular-nums">
                  {papers.filter((p) => !p.folder).length}
                </span>
              </span>
            </button>

            {allFolders.map((f) => (
              <div key={f} className="group/folder relative">
                {deleteFolderConfirm === f ? (
                  <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-red-50 border border-red-100 animate-fade-in">
                    <span className="text-[11px] text-red-600 flex-1 truncate">Delete &ldquo;{f}&rdquo;?</span>
                    <button
                      onClick={() => handleDeleteFolder(f)}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-red-500 text-white font-medium shrink-0"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setDeleteFolderConfirm(null)}
                      className="text-[10px] text-gray-500 shrink-0"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setActiveFolder(activeFolder === f ? null : f)}
                    onDragOver={(e) => onFolderDragOver(e, f)}
                    onDragLeave={onFolderDragLeave}
                    onDrop={(e) => onFolderDrop(e, f)}
                    className={`w-full text-left text-[12px] px-3 py-2.5 rounded-xl transition-all duration-200 truncate ${
                      dragOverFolder === f
                        ? "bg-violet-50/50 ring-2 ring-violet-300/40 ring-inset"
                        : activeFolder === f
                          ? "bg-gradient-to-r from-gray-800 to-gray-900 text-white font-medium shadow-md shadow-gray-900/10"
                          : "text-gray-600 hover:text-gray-900 hover:bg-white/50"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <FolderIcon className="w-4 h-4 shrink-0" filled={activeFolder === f} />
                      <span className="truncate flex-1">{f}</span>
                      <span className="text-[10px] opacity-50 shrink-0 tabular-nums">{folderCount(f)}</span>
                    </span>
                  </button>
                )}
                {deleteFolderConfirm !== f && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteFolderConfirm(f); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover/folder:opacity-100"
                    title="Delete folder"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>

          <p className="text-[10px] text-gray-300 leading-relaxed pt-2">
            Drag papers onto folders to organize.
          </p>
            </>
          ) : (
            <div className="space-y-2">
              {workspacesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-4 h-4 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
                </div>
              ) : workspaces.length === 0 ? (
                <div className="text-center py-8">
                  <svg className="w-8 h-8 mx-auto text-gray-200 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
                  </svg>
                  <p className="text-[12px] text-gray-400">No saved workspaces</p>
                  <p className="text-[11px] text-gray-300 mt-1">
                    Save a session from the paper view
                  </p>
                </div>
              ) : (
                workspaces.map((ws) => (
                  <div key={ws.id} className="group/ws rounded-xl hover:bg-white/50 transition-all">
                    {deleteWsConfirm === ws.id ? (
                      <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-red-50 border border-red-100 animate-fade-in">
                        <span className="text-[11px] text-red-600 flex-1 truncate">Delete?</span>
                        <button
                          onClick={() => handleDeleteWorkspace(ws.id)}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-red-500 text-white font-medium shrink-0"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setDeleteWsConfirm(null)}
                          className="text-[10px] text-gray-500 shrink-0"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <div className="relative">
                        <button
                          onClick={() => handleOpenWorkspace(ws)}
                          className="w-full text-left px-3 py-2.5"
                        >
                          <p className="text-[12px] font-medium text-gray-700 truncate">{ws.name}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">
                            {ws.paper_ids.length} paper{ws.paper_ids.length !== 1 ? "s" : ""}
                            {" · "}
                            {new Date(ws.updated_at).toLocaleDateString()}
                          </p>
                        </button>
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/ws:opacity-100 transition-all">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleExportBibtex({ workspace_id: ws.id }, `Workspace: ${ws.name}`); }}
                            className="p-1 rounded-md text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-all"
                            title="Export BibTeX"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                            </svg>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeleteWsConfirm(ws.id); }}
                            className="p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all"
                            title="Delete workspace"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
              <button
                onClick={loadWorkspaces}
                className="w-full text-[11px] text-gray-400 hover:text-gray-600 transition-colors py-1.5 font-medium"
              >
                Refresh
              </button>
            </div>
          )}
        </aside>

        {/* Paper list */}
        <div className="flex-1 overflow-y-auto p-6">
          {fetchError ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <p className="text-[14px] text-red-500">{fetchError}</p>
                <button onClick={() => { setFetchError(""); api.listPapers().then(setPapers).catch(() => setFetchError("Failed to load papers.")); }} className="text-[13px] font-medium text-gray-600 hover:text-gray-900 transition-colors">Retry</button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <FolderIcon className="w-10 h-10 mx-auto text-gray-200" />
                <p className="text-[14px] text-gray-500">
                  {activeFolder !== null ? "No papers in this folder." : "No papers found."}
                </p>
                <button
                  onClick={() => router.push("/dashboard")}
                  className="text-[13px] text-gray-500 hover:text-gray-900 transition-colors font-medium"
                >
                  Upload a paper &rarr;
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {visiblePapers.map((p) => (
                <div
                  key={p.id}
                  draggable
                  onDragStart={(e) => onPaperDragStart(e, p.id)}
                  onDragEnd={onPaperDragEnd}
                  className="group flex items-start gap-3 px-4 py-4 rounded-2xl hover:bg-white/50 transition-all duration-200 cursor-grab active:cursor-grabbing"
                >
                  <div className="shrink-0 mt-2 text-gray-200 group-hover:text-gray-400 transition-colors">
                    <svg className="w-3 h-3" viewBox="0 0 6 10" fill="currentColor">
                      <circle cx="1" cy="1" r="1" />
                      <circle cx="5" cy="1" r="1" />
                      <circle cx="1" cy="5" r="1" />
                      <circle cx="5" cy="5" r="1" />
                      <circle cx="1" cy="9" r="1" />
                      <circle cx="5" cy="9" r="1" />
                    </svg>
                  </div>

                  <div
                    className="flex-1 text-left min-w-0 cursor-pointer"
                    onClick={() => router.push(`/paper/${p.id}`)}
                  >
                    <p className="text-[14px] font-medium leading-snug truncate text-gray-800 group-hover:text-gray-900">
                      {(p.title && !p.title.match(/^[a-f0-9]{8,}$/i) ? p.title : `Paper ${p.id.slice(0, 6)}`)}
                    </p>
                    {p.authors?.length > 0 && (
                      <p className="text-[12px] text-gray-400 truncate mt-0.5">
                        {p.authors.slice(0, 3).join(", ")}
                        {p.authors.length > 3 ? " et al." : ""}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-2">
                      {p.folder && (
                        <span className="text-[10px] text-gray-400 bg-gray-50 border border-gray-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <FolderIcon className="w-2.5 h-2.5" />
                          {p.folder}
                        </span>
                      )}
                      {p.tags?.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pt-1">
                    {movingPaper === p.id ? (
                      <div className="flex flex-col gap-1 animate-fade-in">
                        <p className="text-[10px] text-gray-400 font-medium">Move to:</p>
                        <button
                          onClick={() => handleMoveToFolder(p.id, "")}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-gray-50 text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors text-left"
                        >
                          Unfiled
                        </button>
                        {allFolders.map((f) => (
                          <button
                            key={f}
                            onClick={() => handleMoveToFolder(p.id, f)}
                            className={`text-[10px] px-2 py-0.5 rounded-md transition-colors text-left ${
                              p.folder === f
                                ? "bg-gray-100 text-gray-900 font-medium"
                                : "bg-gray-50 text-gray-500 hover:text-gray-900 hover:bg-gray-100"
                            }`}
                          >
                            {f}
                          </button>
                        ))}
                        <button
                          onClick={() => setMovingPaper(null)}
                          className="text-[10px] text-gray-400 mt-0.5"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setMovingPaper(p.id)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                        title="Move to folder"
                      >
                        <FolderIcon className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {deleteConfirm === p.id ? (
                      <div className="flex items-center gap-1 animate-fade-in">
                        <button
                          onClick={() => handleDelete(p.id)}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-red-500 text-white font-medium"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          className="text-[10px] text-gray-400"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(p.id)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {hasMore && (
                <button
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="w-full text-center text-[13px] text-gray-500 hover:text-gray-800 py-3 font-medium transition-colors"
                >
                  Show more ({filtered.length - visibleCount} remaining)
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </main>

      <BibtexModal
        open={bibtexModal.open}
        onClose={() => setBibtexModal({ open: false })}
        paperIds={bibtexModal.paperIds}
        folder={bibtexModal.folder}
        workspaceId={bibtexModal.workspaceId}
        label={bibtexModal.label}
      />
    </>
  );
}

export default function LibraryPage() {
  return <LibraryContent />;
}
