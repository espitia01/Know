"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { getAuthHeadersSync } from "@/lib/api";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;

interface PdfViewerProps {
  url: string;
  onTextSelected?: (text: string, rect: DOMRect) => void;
  onSelectionClear?: () => void;
}

const PAGE_GAP = 16;
const BUFFER_PAGES = 2;

export function PdfViewer({ url, onTextSelected, onSelectionClear }: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [loadError, setLoadError] = useState("");
  const [visibleRange, setVisibleRange] = useState({ start: 1, end: 5 });
  const containerRef = useRef<HTMLDivElement>(null);
  const pageHeightRef = useRef(800);
  const retryCount = useRef(0);

  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    setPdfData(null);
    retryCount.current = 0;

    const headers: Record<string, string> = getAuthHeadersSync();

    function attemptFetch() {
      fetch(url, { headers })
        .then((r) => {
          if (!r.ok) {
            if (r.status === 404) throw new Error("PDF_NOT_FOUND");
            throw new Error(`HTTP ${r.status}`);
          }
          return r.arrayBuffer();
        })
        .then((buf) => {
          if (!cancelled) setPdfData(buf);
        })
        .catch((e) => {
          if (cancelled) return;
          if (e.message === "PDF_NOT_FOUND" || retryCount.current >= 3) {
            setLoadError(e.message || "Failed to load PDF");
          } else {
            retryCount.current++;
            setTimeout(() => { if (!cancelled) attemptFetch(); }, 1000 * retryCount.current);
          }
        });
    }

    attemptFetch();
    return () => { cancelled = true; };
  }, [url, retryKey]);

  const fileData = useMemo(() => {
    if (!pdfData) return null;
    return { data: new Uint8Array(pdfData) };
  }, [pdfData]);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setVisibleRange({ start: 1, end: Math.min(n, 1 + BUFFER_PAGES * 2) });
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
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          updateVisibleRange();
          ticking = false;
        });
      }
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [updateVisibleRange]);

  const handlePageRender = useCallback((pageNum: number) => {
    const el = containerRef.current?.querySelector(`[data-page-number="${pageNum}"]`);
    if (el) {
      const h = el.getBoundingClientRect().height;
      if (Math.abs(h - pageHeightRef.current) > 2) {
        pageHeightRef.current = h;
        updateVisibleRange();
      }
    }
  }, [updateVisibleRange]);

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
  const zoomReset = () => setScale(1.0);

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
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-black/[0.06] glass-subtle">
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/50 transition-all text-[15px]"
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={zoomReset}
            className="h-7 px-2 flex items-center justify-center rounded-lg text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/50 transition-all font-mono"
            aria-label={`Reset zoom (currently ${Math.round(scale * 100)}%)`}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            onClick={zoomIn}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/50 transition-all text-[15px]"
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <div className="h-4 w-px bg-black/[0.06]" />

        {numPages > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handlePageInputSubmit()}
              onBlur={handlePageInputSubmit}
              className="w-10 h-6 text-center rounded-lg border border-black/[0.06] bg-white/40 text-[11px] backdrop-blur-sm"
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
                  <p className="text-[13px] font-medium text-gray-700">PDF no longer available</p>
                  <p className="text-[12px] text-gray-500">This paper&apos;s file was lost during a server update. Please re-upload the PDF from your library.</p>
                </>
              ) : (
                <>
                  <p className="text-[13px] text-destructive">Failed to load PDF</p>
                  <button
                    onClick={() => { setLoadError(""); retryCount.current = 0; setRetryKey((k) => k + 1); }}
                    className="text-[12px] font-medium text-gray-600 hover:text-gray-900 transition-all px-3 py-1.5 rounded-xl glass hover:bg-white/60"
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
                    className="shadow-lg bg-white"
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
