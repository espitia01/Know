"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { api, PaperListEntry } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { AuthGuard } from "@/components/AuthGuard";

function LibraryContent() {
  const router = useRouter();
  const [papers, setPapers] = useState<PaperListEntry[]>([]);
  const [search, setSearch] = useState("");
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [movingPaper, setMovingPaper] = useState<string | null>(null);

  useEffect(() => {
    api.listPapers().then(setPapers).catch(() => {});
  }, []);

  const folders = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => { if (p.folder) set.add(p.folder); });
    return [...set].sort();
  }, [papers]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    papers.forEach((p) => p.tags?.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [papers]);

  const filtered = useMemo(() => {
    let list = papers;
    if (activeFolder !== null) list = list.filter((p) => (p.folder || "") === activeFolder);
    if (activeTag) list = list.filter((p) => p.tags?.includes(activeTag));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        p.title.toLowerCase().includes(q) ||
        p.authors?.some((a) => a.toLowerCase().includes(q)) ||
        p.tags?.some((t) => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [papers, activeFolder, activeTag, search]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.deletePaper(id);
      setPapers((prev) => prev.filter((p) => p.id !== id));
    } catch (e) { console.error(e); }
    setDeleteConfirm(null);
  }, []);

  const handleMove = useCallback(async (paperId: string, folder: string) => {
    try {
      await api.movePaperToFolder(paperId, folder);
      setPapers((prev) => prev.map((p) => p.id === paperId ? { ...p, folder } : p));
    } catch (e) { console.error(e); }
    setMovingPaper(null);
  }, []);

  const handleAddTag = useCallback(async (paperId: string) => {
    const tag = tagInput.trim();
    if (!tag) return;
    const paper = papers.find((p) => p.id === paperId);
    if (!paper) return;
    const newTags = [...new Set([...(paper.tags || []), tag])];
    try {
      await api.updateTags(paperId, newTags);
      setPapers((prev) => prev.map((p) => p.id === paperId ? { ...p, tags: newTags } : p));
    } catch (e) { console.error(e); }
    setTagInput("");
    setEditingTag(null);
  }, [tagInput, papers]);

  const handleRemoveTag = useCallback(async (paperId: string, tag: string) => {
    const paper = papers.find((p) => p.id === paperId);
    if (!paper) return;
    const newTags = (paper.tags || []).filter((t) => t !== tag);
    try {
      await api.updateTags(paperId, newTags);
      setPapers((prev) => prev.map((p) => p.id === paperId ? { ...p, tags: newTags } : p));
    } catch (e) { console.error(e); }
  }, [papers]);

  const handleCreateFolder = () => {
    const name = newFolder.trim();
    if (!name) return;
    setNewFolder("");
    setShowNewFolder(false);
    setActiveFolder(name);
  };

  return (
    <main className="flex-1 flex flex-col h-screen overflow-hidden">
      <header className="shrink-0 flex items-center gap-3 px-5 h-12 border-b bg-background/80 backdrop-blur-sm">
        <button onClick={() => router.push("/")} className="text-muted-foreground hover:text-foreground transition-colors text-[13px] font-medium">
          &larr;
        </button>
        <div className="h-4 w-px bg-border" />
        <h1 className="text-[15px] font-semibold">Library</h1>
        <div className="flex-1" />
        <span className="text-[12px] text-muted-foreground/60">{papers.length} papers</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 border-r bg-accent/20 overflow-y-auto p-4 space-y-5">
          <div>
            <Input
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-[13px] h-8"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Folders</p>
              <button onClick={() => setShowNewFolder(!showNewFolder)} className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors">
                +
              </button>
            </div>

            {showNewFolder && (
              <div className="flex gap-1 animate-fade-in">
                <Input
                  placeholder="Name..."
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
                  className="text-[12px] h-7 flex-1"
                  autoFocus
                />
                <button onClick={handleCreateFolder} className="text-[11px] text-foreground font-medium px-2">Go</button>
              </div>
            )}

            <button
              onClick={() => { setActiveFolder(null); setActiveTag(null); }}
              className={`w-full text-left text-[12px] px-2 py-1 rounded-md transition-colors ${
                activeFolder === null && !activeTag ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              All Papers
            </button>
            <button
              onClick={() => { setActiveFolder(""); setActiveTag(null); }}
              className={`w-full text-left text-[12px] px-2 py-1 rounded-md transition-colors ${
                activeFolder === "" ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              Unfiled
            </button>
            {folders.map((f) => (
              <button
                key={f}
                onClick={() => { setActiveFolder(f); setActiveTag(null); }}
                className={`w-full text-left text-[12px] px-2 py-1 rounded-md transition-colors truncate ${
                  activeFolder === f ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {allTags.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Tags</p>
              {allTags.map((t) => (
                <button
                  key={t}
                  onClick={() => { setActiveTag(activeTag === t ? null : t); setActiveFolder(null); }}
                  className={`w-full text-left text-[12px] px-2 py-1 rounded-md transition-colors truncate ${
                    activeTag === t ? "bg-foreground text-background font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                >
                  # {t}
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Main */}
        <div className="flex-1 overflow-y-auto p-5">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <p className="text-[14px] text-muted-foreground">No papers found.</p>
                <button onClick={() => router.push("/")} className="text-[13px] text-foreground/60 hover:text-foreground transition-colors font-medium">
                  Upload a paper
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((p) => (
                <div key={p.id} className="group flex items-start gap-3 px-4 py-3 rounded-lg hover:bg-accent transition-colors duration-150">
                  <button
                    className="flex-1 text-left min-w-0"
                    onClick={() => router.push(`/paper/${p.id}`)}
                  >
                    <p className="text-[14px] font-medium leading-snug truncate">{p.title || `paper-${p.id}`}</p>
                    {p.authors?.length > 0 && (
                      <p className="text-[12px] text-muted-foreground/60 truncate mt-0.5">{p.authors.slice(0, 3).join(", ")}{p.authors.length > 3 ? " et al." : ""}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {p.folder && (
                        <span className="text-[10px] text-muted-foreground/50 bg-muted px-2 py-0.5 rounded-full">{p.folder}</span>
                      )}
                      {p.tags?.map((t) => (
                        <span key={t} className="text-[10px] text-muted-foreground/60 bg-accent px-2 py-0.5 rounded-full flex items-center gap-1">
                          # {t}
                          <button
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleRemoveTag(p.id, t); }}
                            className="hover:text-destructive ml-0.5"
                          >
                            &times;
                          </button>
                        </span>
                      ))}
                      {p.notes_count > 0 && (
                        <span className="text-[10px] text-muted-foreground/40">{p.notes_count} note{p.notes_count !== 1 ? "s" : ""}</span>
                      )}
                    </div>
                  </button>

                  <div className="flex gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                    {/* Tag */}
                    {editingTag === p.id ? (
                      <div className="flex items-center gap-1 animate-fade-in">
                        <input
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleAddTag(p.id); if (e.key === "Escape") setEditingTag(null); }}
                          placeholder="tag..."
                          className="text-[11px] w-20 px-1.5 py-0.5 rounded border bg-background"
                          autoFocus
                        />
                        <button onClick={() => handleAddTag(p.id)} className="text-[10px] font-medium text-foreground">Add</button>
                        <button onClick={() => setEditingTag(null)} className="text-[10px] text-muted-foreground">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingTag(p.id); setTagInput(""); }}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                        title="Add tag"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
                        </svg>
                      </button>
                    )}

                    {/* Move */}
                    {movingPaper === p.id ? (
                      <div className="flex items-center gap-1 animate-fade-in">
                        {folders.filter((f) => f !== p.folder).map((f) => (
                          <button key={f} onClick={() => handleMove(p.id, f)} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground">{f}</button>
                        ))}
                        {p.folder && <button onClick={() => handleMove(p.id, "")} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground">Unfiled</button>}
                        <button onClick={() => setMovingPaper(null)} className="text-[10px] text-muted-foreground">Cancel</button>
                      </div>
                    ) : folders.length > 0 ? (
                      <button
                        onClick={() => setMovingPaper(p.id)}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                        title="Move"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                      </button>
                    ) : null}

                    {/* Delete */}
                    {deleteConfirm === p.id ? (
                      <div className="flex items-center gap-1 animate-fade-in">
                        <button onClick={() => handleDelete(p.id)} className="text-[10px] px-1.5 py-0.5 rounded bg-destructive text-white font-medium">Delete</button>
                        <button onClick={() => setDeleteConfirm(null)} className="text-[10px] text-muted-foreground">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(p.id)}
                        className="p-1 rounded-md text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
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
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function LibraryPage() {
  return <AuthGuard><LibraryContent /></AuthGuard>;
}
