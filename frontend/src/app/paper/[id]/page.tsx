"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { PaperRenderer } from "@/components/paper/PaperRenderer";
import { BottomPanel } from "@/components/panel/BottomPanel";
import { AuthGuard } from "@/components/AuthGuard";

const MIN_PANEL = 180;
const MAX_PANEL = 600;
const DEFAULT_PANEL = 320;

function PaperContent() {
  const params = useParams();
  const router = useRouter();
  const paperId = params.id as string;
  const { paper, setPaper, loading, setLoading, panelVisible, togglePanel, setPreReading, setPreReadingLoading, setAssumptions, setAssumptionsLoading, setNotes } = useStore();
  const [error, setError] = useState("");
  const [siUploading, setSiUploading] = useState(false);
  const siInputRef = useRef<HTMLInputElement>(null);

  const [panelH, setPanelH] = useState(DEFAULT_PANEL);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const autoAnalyzed = useRef(false);

  useEffect(() => {
    if (paper?.id === paperId) return;
    setLoading(true);
    api
      .getPaper(paperId)
      .then((p) => setPaper(p))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [paperId, paper?.id, setPaper, setLoading]);

  useEffect(() => {
    if (!paper || autoAnalyzed.current || paper.id !== paperId) return;
    autoAnalyzed.current = true;
    const cache = paper.cached_analysis || {};

    if (paper.notes) setNotes(paper.notes);

    if (cache.pre_reading) {
      setPreReading(cache.pre_reading);
    } else {
      setPreReadingLoading(true);
      api.analyze(paperId)
        .then((r) => setPreReading(r))
        .catch(() => {})
        .finally(() => setPreReadingLoading(false));
    }

    if (cache.assumptions) {
      setAssumptions(cache.assumptions.assumptions || []);
    } else {
      setAssumptionsLoading(true);
      api.getAssumptions(paperId)
        .then((r) => setAssumptions(r.assumptions))
        .catch(() => {})
        .finally(() => setAssumptionsLoading(false));
    }
  }, [paper, paperId, setPreReading, setPreReadingLoading, setAssumptions, setAssumptionsLoading, setNotes]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = panelH;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dy = startY.current - ev.clientY;
      setPanelH(Math.min(MAX_PANEL, Math.max(MIN_PANEL, startH.current + dy)));
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
  }, [panelH]);

  const handleSIUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSiUploading(true);
    try {
      const updated = await api.uploadSI(paperId, file);
      setPaper(updated);
    } catch (err) {
      console.error("SI upload failed:", err);
    } finally {
      setSiUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3 animate-fade-in">
          <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin mx-auto" />
          <p className="text-[14px] text-muted-foreground">Loading paper...</p>
        </div>
      </div>
    );
  }

  if (error || !paper) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4 animate-fade-in">
          <p className="text-destructive text-[14px]">{error || "Paper not found"}</p>
          <button
            onClick={() => router.push("/")}
            className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Back to library
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <header className="shrink-0 flex items-center gap-3 px-4 h-11 border-b bg-background/80 backdrop-blur-sm">
        <button
          onClick={() => router.push("/")}
          className="text-muted-foreground hover:text-foreground transition-colors text-[13px] font-medium shrink-0"
        >
          &larr;
        </button>

        <div className="h-4 w-px bg-border shrink-0" />

        <span className="text-[13px] text-foreground/70 truncate flex-1 font-medium">
          {paper.title}
        </span>

        {paper.has_si && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted px-2 py-0.5 rounded-full font-medium">
            SI
          </span>
        )}

        <input ref={siInputRef} type="file" accept=".pdf" className="hidden" onChange={handleSIUpload} />

        <button
          onClick={() => siInputRef.current?.click()}
          disabled={siUploading}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors font-medium shrink-0"
        >
          {siUploading ? "Uploading..." : paper.has_si ? "Replace SI" : "+ SI"}
        </button>

        <div className="h-4 w-px bg-border shrink-0" />

        <button
          onClick={togglePanel}
          className={`text-[12px] font-medium transition-colors shrink-0 ${
            panelVisible ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {panelVisible ? "Hide Analysis" : "Show Analysis"}
        </button>

        <button
          onClick={() => router.push("/settings")}
          className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        <div className="max-w-[680px] mx-auto px-6 py-8">
          <PaperRenderer
            paperId={paper.id}
            title={paper.title}
            authors={paper.authors}
            affiliations={paper.affiliations || []}
            abstract={paper.abstract}
            contentMarkdown={paper.content_markdown}
            figures={paper.figures}
            references={paper.references || []}
          />
        </div>
      </div>

      {panelVisible && (
        <>
          <div
            className="drag-handle shrink-0 h-2 flex items-center justify-center border-t bg-accent/50"
            onMouseDown={onDragStart}
          >
            <div className="drag-bar w-10 h-[2px] rounded-full bg-foreground/10 transition-colors" />
          </div>

          <div
            className="shrink-0 overflow-hidden bg-background border-t"
            style={{ height: panelH }}
          >
            <BottomPanel paperId={paper.id} />
          </div>
        </>
      )}
    </div>
  );
}

export default function PaperPage() {
  return <AuthGuard><PaperContent /></AuthGuard>;
}
