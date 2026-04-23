"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { getAuthHeadersSync } from "@/lib/api";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// Bundle the PDF.js worker from node_modules via the URL constructor pattern
// Next.js/Webpack understands. Previously we pulled it from unpkg.com on
// every load, which (a) breaks the app if unpkg is down, (b) leaks the
// session to a third-party CDN, and (c) can desync with the installed
// pdfjs-dist version.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfViewerProps {
  url: string;
  paperId?: string;
  onTextSelected?: (text: string, rect: DOMRect) => void;
  onSelectionClear?: () => void;
}

const PAGE_GAP = 16;
const BUFFER_PAGES = 2;
const SCROLL_STORAGE_PREFIX = "know-pdf-scroll:";
// Baseline render scale used as the displayed "100%". The old 1.0 baseline
// produced text that most readers found uncomfortably small on modern
// retina displays; 1.4 matches what users were manually zooming to almost
// every session. All displayed percentages are normalised against this.
const BASELINE_SCALE = 1.4;

export function PdfViewer({ url, paperId, onTextSelected, onSelectionClear }: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(BASELINE_SCALE);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [loadError, setLoadError] = useState("");
  const [visibleRange, setVisibleRange] = useState({ start: 1, end: 5 });
  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightRef = useRef(800);

  const [retryKey, setRetryKey] = useState(0);
  // Whether we've already restored the persisted scroll for this paper. We
  // restore exactly once per (paperId, retryKey) pair, on the first page
  // that renders — before any user scrolling writes new values.
  const scrollRestoredRef = useRef(false);

  // Hand the URL straight to PDF.js instead of fetching the entire binary
  // ourselves first. PDF.js can issue HTTP range requests and start
  // rendering page 1 before the rest of the document has downloaded,
  // which makes large scientific papers feel noticeably snappier — the
  // previous approach blocked the viewer on the full ArrayBuffer even
  // though most users never scroll past the first handful of pages.
  // Memoised so react-pdf doesn't see a new file prop on every render.
  const fileData = useMemo(() => {
    if (!url) return null;
    return {
      url,
      httpHeaders: getAuthHeadersSync(),
      withCredentials: false,
    };
    // `retryKey` is included so "Retry" reliably re-fetches from PDF.js.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryKey]);

  // Reset document-scoped state whenever the URL changes so we don't show
  // stale num-pages from a previous paper while the new one is loading.
  useEffect(() => {
    setLoadError("");
    setNumPages(0);
    setCurrentPage(1);
    setPageInput("1");
    setVisibleRange({ start: 1, end: 5 });
  }, [url, retryKey]);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setVisibleRange({ start: 1, end: Math.min(n, 1 + BUFFER_PAGES * 2) });
  }, []);

  const onDocumentLoadError = useCallback((error: Error) => {
    const msg = error?.message || "Unknown error";
    console.error("PDF render error:", msg, error);
    if (msg.includes("worker") || msg.includes("Worker")) {
      setLoadError("PDF worker failed to load. Please refresh the page.");
    } else if (msg.includes("Invalid PDF") || msg.includes("password")) {
      setLoadError("This PDF file appears to be corrupted or password-protected.");
    } else {
      setLoadError(msg || "Failed to render PDF");
    }
  }, []);

  const updateVisibleRange = useCallback(() => {
    const container = containerRef.current;
    if (!container || numPages === 0) return;

    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;
    const totalHeight = pageHeightRef.current + PAGE_GAP;

    const firstVisible = Math.max(1, Math.floor(scrollTop / totalHeight) + 1);
    const lastVisible = Math.min(numPages, Math.ceil((scrollTop + viewportHeight) / totalHeight) + 1);

    const start = Math.max(1, firstVisible - BUFFER_PAGES);
    const end = Math.min(numPages, lastVisible + BUFFER_PAGES);

    setCurrentPage(firstVisible);
    setPageInput(String(firstVisible));
    setVisibleRange((prev) => {
      if (prev.start === start && prev.end === end) return prev;
      return { start, end };
    });
  }, [numPages]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let ticking = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          updateVisibleRange();
          ticking = false;
        });
      }
      // Persist scroll position (debounced) so a refresh restores the
      // reader to exactly where they left off. We store a *scale-invariant*
      // page ratio rather than raw pixels — pixel scrollTop depends on both
      // the current zoom and whichever page happens to have been measured
      // first, so a value saved at 140% zoom would place the reader 40%
      // further down after a refresh that starts at 100%. Page-ratio
      // storage sidesteps both problems.
      if (paperId && scrollRestoredRef.current) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            const pageStride = pageHeightRef.current + PAGE_GAP;
            if (pageStride > 0) {
              const pageRatio = container.scrollTop / pageStride;
              localStorage.setItem(
                `${SCROLL_STORAGE_PREFIX}${paperId}`,
                pageRatio.toFixed(4),
              );
            }
          } catch { /* quota / private mode — non-fatal */ }
        }, 250);
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [updateVisibleRange, paperId]);

  // Reset the restoration flag whenever we switch to a different paper or
  // reload the same one — the next page render should re-apply the saved
  // scroll for the new document.
  useEffect(() => {
    scrollRestoredRef.current = false;
  }, [paperId, retryKey]);

  const handlePageRender = useCallback((pageNum: number) => {
    const el = containerRef.current?.querySelector(`[data-page-number="${pageNum}"]`);
    if (el) {
      const h = el.getBoundingClientRect().height;
      if (Math.abs(h - pageHeightRef.current) > 2) {
        pageHeightRef.current = h;
        updateVisibleRange();
      }
    }
    // One-shot scroll restoration after the first real page paint. We wait
    // until *a* page renders so we know the page dimensions are final —
    // scrolling before that would overshoot because every placeholder uses
    // the initial 800px estimate. Converting the saved page-ratio through
    // the now-accurate pageHeightRef lands us within a few pixels of the
    // user's last viewport.
    if (!scrollRestoredRef.current && paperId && containerRef.current) {
      const container = containerRef.current;
      try {
        const raw = localStorage.getItem(`${SCROLL_STORAGE_PREFIX}${paperId}`);
        const savedRatio = raw ? parseFloat(raw) : 0;
        if (savedRatio > 0 && Number.isFinite(savedRatio)) {
          const pageStride = pageHeightRef.current + PAGE_GAP;
          const target = Math.round(savedRatio * pageStride);
          container.scrollTop = target;
          // Nudge visibleRange so the target pages actually render —
          // relying purely on the scroll event is flaky when React batches
          // the update with the initial paint.
          updateVisibleRange();
        }
      } catch { /* ignore */ }
      scrollRestoredRef.current = true;
    }
  }, [updateVisibleRange, paperId]);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim()) {
      onSelectionClear?.();
      return;
    }
    let text = sel.toString().trim();
    if (text.length < 2) return;

    text = text
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (text.length < 2) return;

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    onTextSelected?.(text, rect);
  }, [onTextSelected, onSelectionClear]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.getSelection()?.removeAllRanges();
        onSelectionClear?.();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onSelectionClear]);

  const zoomIn = () => setScale((s) => Math.min(3, s + 0.2));
  const zoomOut = () => setScale((s) => Math.max(0.5, s - 0.2));
  const zoomReset = () => setScale(BASELINE_SCALE);
  const displayedPercent = Math.round((scale / BASELINE_SCALE) * 100);

  const scrollToPage = (page: number) => {
    const el = containerRef.current?.querySelector(`[data-page-number="${page}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (containerRef.current) {
      const totalHeight = pageHeightRef.current + PAGE_GAP;
      containerRef.current.scrollTop = (page - 1) * totalHeight;
    }
  };

  const handlePageInputSubmit = () => {
    const p = parseInt(pageInput);
    if (p >= 1 && p <= numPages) {
      scrollToPage(p);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border glass-subtle">
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-all text-[15px]"
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={zoomReset}
            className="h-7 px-2 flex items-center justify-center rounded-lg text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-all font-mono"
            aria-label={`Reset zoom (currently ${displayedPercent}%)`}
          >
            {displayedPercent}%
          </button>
          <button
            onClick={zoomIn}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-all text-[15px]"
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <div className="h-4 w-px bg-border" />

        {numPages > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handlePageInputSubmit()}
              onBlur={handlePageInputSubmit}
              className="w-10 h-6 text-center rounded-lg border border-border bg-background/60 text-[11px] backdrop-blur-sm"
            />
            <span>/ {numPages}</span>
          </div>
        )}

        <div className="flex-1" />

        <span className="text-[10px] text-muted-foreground/50">
          Select text to analyze
        </span>
      </div>

      {/* PDF Pages */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-900"
        onMouseUp={handleMouseUp}
      >
        {loadError ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center space-y-3 max-w-sm px-6">
              {loadError === "PDF_NOT_FOUND" ? (
                <>
                  <p className="text-[13px] font-medium text-foreground/90">PDF no longer available</p>
                  <p className="text-[12px] text-muted-foreground">This paper&apos;s file was lost during a server update. Please re-upload the PDF from your library.</p>
                </>
              ) : (
                <>
                  <p className="text-[13px] text-destructive">Failed to load PDF</p>
                  <button
                    onClick={() => { setLoadError(""); setRetryKey((k) => k + 1); }}
                    className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-all px-3 py-1.5 rounded-xl glass hover:bg-accent"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>
        ) : !fileData ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center space-y-3">
              <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin mx-auto" />
              <p className="text-[13px] text-muted-foreground">Loading PDF...</p>
            </div>
          </div>
        ) : (
          <Document
            file={fileData}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center h-64">
                <div className="text-center space-y-3">
                  <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin mx-auto" />
                  <p className="text-[13px] text-muted-foreground">Rendering PDF...</p>
                </div>
              </div>
            }
            error={
              <div className="flex items-center justify-center h-64">
                <p className="text-[13px] text-destructive">Failed to render PDF</p>
              </div>
            }
          >
            <div className="flex flex-col items-center py-4" style={{ gap: `${PAGE_GAP}px` }}>
              {Array.from({ length: numPages }, (_, i) => {
                const pageNum = i + 1;
                const isVisible = pageNum >= visibleRange.start && pageNum <= visibleRange.end;

                if (!isVisible) {
                  return (
                    <div
                      key={pageNum}
                      data-page-number={pageNum}
                      style={{ height: `${pageHeightRef.current}px`, width: "100%" }}
                      className="flex items-center justify-center"
                    >
                      <span className="text-[11px] text-muted-foreground/30">Page {pageNum}</span>
                    </div>
                  );
                }

                return (
                  <Page
                    key={pageNum}
                    pageNumber={pageNum}
                    scale={scale}
                    className="shadow-lg bg-card"
                    renderTextLayer={true}
                    renderAnnotationLayer={true}
                    onRenderSuccess={() => handlePageRender(pageNum)}
                  />
                );
              })}
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}
