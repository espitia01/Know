"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { getAuthHeadersSync, SelectionAnalysisResult } from "@/lib/api";
import { useStore } from "@/lib/store";
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

  // Selection history provides the "Kindle-style" underlines we paint
  // on top of each page. Reading the array directly would re-render the
  // entire viewer every time a new analysis streams in; we only need a
  // stable reference to `selectionHistory` when drawing, so we pull it
  // from the store lazily inside the draw callback via `getState`.
  const selectionHistory = useStore((s) => s.selectionHistory);
  const openSelectionFromHistory = useStore((s) => s.openSelectionFromHistory);

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

  // Paint Kindle-style underlines for every history entry found on a
  // given page. We run this (a) after each page's onRenderSuccess and
  // (b) whenever selectionHistory changes while pages are already
  // mounted. Matching is tolerant of whitespace collapsing — the text
  // layer inserts soft line breaks that a strict substring search would
  // miss — so we convert the needle into a regex whose inter-word
  // whitespace is flexible (`\s+`).
  const drawUnderlinesForPage = useCallback((pageEl: HTMLElement, history: SelectionAnalysisResult[]) => {
    const textLayer = pageEl.querySelector(".react-pdf__Page__textContent") as HTMLElement | null;
    if (!textLayer) return;

    pageEl.querySelectorAll(".know-selection-overlay").forEach((n) => n.remove());
    if (history.length === 0) return;

    const pageStyle = getComputedStyle(pageEl);
    if (pageStyle.position === "static") pageEl.style.position = "relative";

    // Collect every text node under the layer and build a flat string
    // along with (startOffset, node) pairs so we can cheaply translate
    // a character index back into a (node, localOffset) pair for Range
    // construction.
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    const offsets: Array<{ start: number; node: Text }> = [];
    let combined = "";
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const text = (n as Text).data;
      offsets.push({ start: combined.length, node: n as Text });
      combined += text;
    }
    if (!combined) return;

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const locate = (flat: number) => {
      for (let i = offsets.length - 1; i >= 0; i--) {
        if (offsets[i].start <= flat) {
          return { node: offsets[i].node, offset: Math.min(flat - offsets[i].start, offsets[i].node.data.length) };
        }
      }
      return null;
    };

    const overlay = document.createElement("div");
    overlay.className = "know-selection-overlay";
    const pageRect = pageEl.getBoundingClientRect();

    // Iterate newest-first so that the most recent underline wins when
    // two selections overlap (they're stacked but newer-on-top reads
    // clearest). Cap per-page matches at 12 to keep the DOM light on
    // papers where the user analyzes dozens of selections.
    const seenRanges: Array<[number, number]> = [];
    let painted = 0;
    for (let i = 0; i < history.length && painted < 12; i++) {
      const entry = history[i];
      const raw = entry.selected_text?.trim();
      if (!raw || raw.length < 8) continue;
      // Fuzzy match: split on whitespace, re-join with \s+ so line wraps
      // in the text layer don't break the match.
      const parts = raw.split(/\s+/).map(escapeRe);
      if (parts.length === 0) continue;
      let pattern: RegExp;
      try {
        pattern = new RegExp(parts.join("\\s+"), "i");
      } catch {
        continue;
      }
      const m = pattern.exec(combined);
      if (!m || m.index == null) continue;
      const start = m.index;
      const end = start + m[0].length;

      const overlaps = seenRanges.some(([s, e]) => !(end <= s || start >= e));
      if (overlaps) continue;
      seenRanges.push([start, end]);

      const startLoc = locate(start);
      const endLoc = locate(end);
      if (!startLoc || !endLoc) continue;

      const range = document.createRange();
      try {
        range.setStart(startLoc.node, startLoc.offset);
        range.setEnd(endLoc.node, endLoc.offset);
      } catch {
        continue;
      }
      const rects = range.getClientRects();
      for (const r of Array.from(rects)) {
        if (r.width < 4 || r.height < 4) continue;
        const div = document.createElement("div");
        div.className = "know-selection-underline";
        div.style.left = `${r.left - pageRect.left}px`;
        div.style.top = `${r.top - pageRect.top}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
        div.title = "Open past analysis for this selection";
        // We intentionally *don't* stop mousedown propagation: the user
        // must still be able to start a fresh text selection from an
        // already-underlined region. A click (mousedown + mouseup at
        // roughly the same spot) jumps to the stored analysis; a drag
        // falls through to the native selection engine because no
        // `click` event fires when the cursor moves far enough.
        div.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          openSelectionFromHistory(entry);
        });
        overlay.appendChild(div);
      }
      painted++;
    }

    if (overlay.childElementCount > 0) pageEl.appendChild(overlay);
  }, [openSelectionFromHistory]);

  // Re-paint every visible page when the selection history changes so
  // newly added (or removed) underlines appear immediately, without
  // waiting for the user to scroll off and back.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pages = container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]");
    pages.forEach((pageEl) => drawUnderlinesForPage(pageEl, selectionHistory));
  }, [selectionHistory, drawUnderlinesForPage, scale]);

  const handlePageRender = useCallback((pageNum: number) => {
    const el = containerRef.current?.querySelector(`[data-page-number="${pageNum}"]`) as HTMLElement | null;
    if (el) {
      const h = el.getBoundingClientRect().height;
      if (Math.abs(h - pageHeightRef.current) > 2) {
        pageHeightRef.current = h;
        updateVisibleRange();
      }
      // Paint history underlines once the text layer is in the DOM. We
      // defer a frame because react-pdf appends the text layer
      // asynchronously *after* onRenderSuccess fires on some versions.
      requestAnimationFrame(() => {
        drawUnderlinesForPage(el, useStore.getState().selectionHistory);
      });
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
  }, [updateVisibleRange, paperId, drawUnderlinesForPage]);

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

  // Safari-style auto-scroll while dragging a selection. When the cursor
  // enters an "edge zone" near the top or bottom of the viewport, we
  // ease the container in that direction so the selection can keep
  // growing without the user having to release and re-drag. The native
  // selection engine picks up the new geometry each frame automatically.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let lastClientY = 0;
    let isSelecting = false;

    const EDGE = 48; // px from viewport edge that triggers auto-scroll
    const MAX_SPEED = 24; // px per frame at the very edge

    const tick = () => {
      if (!isSelecting) { rafId = null; return; }
      const rect = container.getBoundingClientRect();
      const distTop = lastClientY - rect.top;
      const distBottom = rect.bottom - lastClientY;
      let delta = 0;
      if (distTop < EDGE && distTop >= 0) {
        // Closer to edge = faster scroll. Quadratic falloff feels more
        // natural than linear because the acceleration only kicks in
        // once the cursor is meaningfully close to the boundary.
        const t = 1 - distTop / EDGE;
        delta = -Math.round(MAX_SPEED * t * t);
      } else if (distBottom < EDGE && distBottom >= 0) {
        const t = 1 - distBottom / EDGE;
        delta = Math.round(MAX_SPEED * t * t);
      }
      if (delta !== 0) container.scrollTop += delta;
      rafId = requestAnimationFrame(tick);
    };

    const onDown = (e: MouseEvent) => {
      // Only left-button drags initiate a selection; ignore middle/right
      // buttons so we don't steal context-menu or middle-click-scroll.
      if (e.button !== 0) return;
      isSelecting = true;
      lastClientY = e.clientY;
      if (rafId === null) rafId = requestAnimationFrame(tick);
    };
    const onMove = (e: MouseEvent) => {
      if (!isSelecting) return;
      lastClientY = e.clientY;
    };
    const stop = () => {
      isSelecting = false;
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };

    container.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      container.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

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
