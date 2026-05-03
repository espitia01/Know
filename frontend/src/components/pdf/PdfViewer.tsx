"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { api, getAuthHeadersSync, SelectionAnalysisResult } from "@/lib/api";
import { useStore } from "@/lib/store";
import { normalizeSelectionAction } from "@/lib/selectionActions";
import { snapshotDomRect } from "@/lib/domRect";

import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

/** Stable key for double-tap detection on the same highlighted passage. */
function highlightPointerKey(entry: SelectionAnalysisResult): string {
  return `${normalizeSelectionAction(entry.action)}::${(entry.selected_text || "").slice(0, 240)}`;
}

/** MutationObserver helper: overlays must not participate in repaint loops */
function isUnderSelectionOverlay(node: Node | null | undefined): boolean {
  const el =
    node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
  return !!(el && el.closest(".know-selection-overlay"));
}

function mutationAffectsPdfTextLayer(muts: readonly MutationRecord[]): boolean {
  for (const m of muts) {
    if (isUnderSelectionOverlay(m.target)) continue;
    if (m.type === "characterData") return true;
    if (m.type === "attributes" && !(m.target instanceof Element && m.target.closest(".know-selection-overlay"))) {
      return true;
    }
    for (const n of [...m.addedNodes, ...m.removedNodes]) {
      if (!isUnderSelectionOverlay(n)) return true;
    }
  }
  return false;
}

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
  /** When true, leave room on the right of the mini toolbar — e.g. floating
   *  “show nav bar” control so “Select text to analyze” is not covered. */
  reserveToolbarRightForOverlay?: boolean;
}

const PAGE_GAP = 16;
const BUFFER_PAGES = 2;

/**
 * Module-scoped cache of object URLs pointing at fully-downloaded PDF
 * blobs. Using a `Map` here (instead of a Zustand slice) keeps the
 * blob URLs out of React state — they're side-effecty handles that
 * don't play nicely with serialisation, and we don't want them to
 * trigger re-renders across the tree. Bounded by `PDF_BLOB_CACHE_SIZE`
 * so we don't hold onto megabytes of PDF indefinitely for users who
 * open many papers in a session.
 */
const pdfBlobCache = new Map<string, string>();
const PDF_BLOB_CACHE_SIZE = 8;
// Baseline render scale used as the displayed "100%". The old 1.0 baseline
// produced text that most readers found uncomfortably small on modern
// retina displays; 1.4 matches what users were manually zooming to almost
// every session. All displayed percentages are normalised against this.
const BASELINE_SCALE = 1.4;
const MIN_ZOOM_SCALE = 0.5;
const MAX_ZOOM_SCALE = 3;

let selectionDeletePopoverCleanup: (() => void) | null = null;

/** Double-click on a saved highlight: offer delete in a small floating menu. */
function openSelectionDeletePopover(clientX: number, clientY: number, onDelete: () => void) {
  selectionDeletePopoverCleanup?.();
  selectionDeletePopoverCleanup = null;

  const backdrop = document.createElement("div");
  backdrop.setAttribute("data-know-selection-popover", "");
  backdrop.className = "fixed inset-0 z-[120] bg-transparent";
  backdrop.style.pointerEvents = "auto";

  const panel = document.createElement("div");
  panel.className =
    "rounded-xl border border-border bg-popover text-popover-foreground shadow-lg shadow-black/15 dark:shadow-black/40 p-2 min-w-[11rem]";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Selection options");
  const pad = 8;
  const w = typeof window !== "undefined" ? window.innerWidth : 400;
  const h = typeof window !== "undefined" ? window.innerHeight : 600;
  const left = Math.max(pad, Math.min(clientX - 12, w - 200 - pad));
  const top = Math.max(pad, Math.min(clientY + 10, h - 100 - pad));
  panel.style.position = "fixed";
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.pointerEvents = "auto";
  panel.style.margin = "0";

  const del = document.createElement("button");
  del.type = "button";
  del.className =
    "w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium text-destructive hover:bg-destructive/10 active:scale-[0.99] transition";
  del.textContent = "Delete selection";

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onEscape);
    if (selectionDeletePopoverCleanup === teardown) selectionDeletePopoverCleanup = null;
  };
  function teardown() {
    close();
  }
  selectionDeletePopoverCleanup = teardown;

  function onEscape(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onEscape);

  del.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete();
    close();
  });

  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });

  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  panel.appendChild(del);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
}

function usePdfCanvasDeviceRatio() {
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    const update = () => {
      const raw = window.devicePixelRatio || 1;
      // Platform DPR capped at 3; no arbitrary minimum — compounded with
      // BASELINE_SCALE, a fractional/device-fudged DPR misaligns pdf.js
      // glyph scaleX() vs the painted canvas pixels.
      setRatio(Math.min(3, raw));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return ratio;
}

/** Outward-only: snapped DOM range must encompass the user's original anchors. */
function snappedRangeDoesNotShrink(origin: Range, snapped: Range): boolean {
  try {
    return (
      snapped.compareBoundaryPoints(Range.START_TO_START, origin) <= 0 &&
      snapped.compareBoundaryPoints(Range.END_TO_END, origin) >= 0
    );
  } catch {
    return false;
  }
}

/**
 * Blink/WebKit/Firefox Selection.modify survives PDF.js glyph-per-span splits
 * where Intl.Segmenter only sees fragments inside one text node.
 */
function snapRangeUsingSelectionModify(origin: Range): Range | null {
  const mod = Selection.prototype.modify;
  if (typeof mod !== "function") return null;

  const sel = window.getSelection();
  if (!sel || origin.collapsed) return null;

  const originClone = origin.cloneRange();
  const restoreOrigin = () => {
    try {
      sel.removeAllRanges();
      sel.addRange(originClone.cloneRange());
    } catch {
      /* ignore */
    }
  };
  try {
    sel.removeAllRanges();
    sel.addRange(origin.cloneRange());
    mod.call(sel, "extend", "backward", "word");
    mod.call(sel, "extend", "forward", "word");
    if (sel.rangeCount === 0 || sel.isCollapsed) {
      restoreOrigin();
      return null;
    }
    const snapped = sel.getRangeAt(0).cloneRange();
    if (!snappedRangeDoesNotShrink(originClone, snapped)) {
      restoreOrigin();
      return null;
    }
    return snapped;
  } catch {
    restoreOrigin();
    return null;
  }
}

/** Expand anchors outward to nearest word boundaries using Intl segments. */
function snapRangeToWordsViaIntl(range: Range): Range | null {
  if (typeof Intl === "undefined" || !("Segmenter" in Intl)) return null;
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  if (startNode.nodeType !== Node.TEXT_NODE) return null;
  if (endNode.nodeType !== Node.TEXT_NODE) return null;

  const seg = new Intl.Segmenter(undefined, { granularity: "word" });

  const startText = startNode.textContent ?? "";
  let newStart = range.startOffset;
  for (const s of seg.segment(startText)) {
    if (!s.isWordLike) continue;
    const segStart = s.index;
    const segEnd = s.index + s.segment.length;
    if (segStart < range.startOffset && range.startOffset < segEnd) {
      newStart = segStart;
      break;
    }
    if (segStart >= range.startOffset) break;
  }

  const endText = endNode.textContent ?? "";
  let newEnd = range.endOffset;
  for (const s of seg.segment(endText)) {
    if (!s.isWordLike) continue;
    const segStart = s.index;
    const segEnd = s.index + s.segment.length;
    if (segStart < range.endOffset && range.endOffset < segEnd) {
      newEnd = segEnd;
      break;
    }
    if (segStart >= range.endOffset) break;
  }

  if (newStart === range.startOffset && newEnd === range.endOffset) return null;
  const next = document.createRange();
  try {
    next.setStart(startNode, newStart);
    next.setEnd(endNode, newEnd);
  } catch {
    return null;
  }
  return next;
}

/** Native extend-by-word first; Intl fallback inside each TEXT_NODE — never shrink coverage. */
function snapRangeToWords(range: Range): Range | null {
  const a = snapRangeUsingSelectionModify(range);
  if (a) return a;
  const b = snapRangeToWordsViaIntl(range);
  if (b && snappedRangeDoesNotShrink(range, b)) return b;
  return null;
}

/** Strong union of every caret rect (multi-line selections collapse badly with `getBoundingClientRect`). */
function unionBoundingRectFromRange(range: Range): DOMRect {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  if (rects.length === 0) return range.getBoundingClientRect();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

export function PdfViewer({
  url,
  paperId,
  onTextSelected,
  onSelectionClear,
  reserveToolbarRightForOverlay = false,
}: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(BASELINE_SCALE);
  const canvasDpr = usePdfCanvasDeviceRatio();
  const documentOptions = useMemo(
    () => ({
      // Bundling every cmap into /public would be huge; load from npm CDN at
      // the exact pdfjs-dist version we ship (same major/minor as the worker).
      // Needed for many math / unicode / non-Latin PDFs.
      cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/standard_fonts/`,
      enableXfa: true,
      useSystemFonts: true,
    }),
    [],
  );
  const [, setCurrentPage] = useState(1);
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
  const removeSelectionFromHistory = useStore((s) => s.removeSelectionFromHistory);
  const savedScrollByPaper = useStore((s) => s.uiPrefs.scrollByPaper);
  const setPdfScroll = useStore((s) => s.setPdfScroll);

  const [retryKey, setRetryKey] = useState(0);
  // Whether we've already restored the persisted scroll for this paper. We
  // restore exactly once per (paperId, retryKey) pair, on the first page
  // that renders — before any user scrolling writes new values.
  const scrollRestoredRef = useRef(false);

  useEffect(() => {
    return () => {
      selectionDeletePopoverCleanup?.();
    };
  }, []);

  // Hand the URL straight to PDF.js for the *first* load so HTTP range
  // requests can start rendering page 1 before the full document has
  // downloaded. In parallel, we stash a full-file Blob in a module
  // cache keyed by `url`, so returning to the same paper later skips
  // the network round-trip entirely and feels instantaneous — which
  // matters a lot for multi-paper sessions where users flip between
  // tabs dozens of times.
  const cachedBlobUrl = pdfBlobCache.get(url);
  const fileData = useMemo(() => {
    if (!url) return null;
    if (cachedBlobUrl) {
      return { url: cachedBlobUrl };
    }
    return {
      url,
      httpHeaders: getAuthHeadersSync(),
      withCredentials: false,
    };
    // `retryKey` is included so "Retry" reliably re-fetches from PDF.js.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryKey, cachedBlobUrl]);

  // Background-download the full PDF only after the reader has been open
  // long enough to show intent. This avoids fighting PDF.js range requests
  // during quick paper checks and skips very large PDFs entirely.
  useEffect(() => {
    if (!url || cachedBlobUrl) return;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const headers = getAuthHeadersSync();
      fetch(url, { headers, signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) return null;
          const size = Number(res.headers.get("content-length") || 0);
          if (size > 25 * 1024 * 1024) {
            try {
              await res.body?.cancel();
            } catch {
              /* ignore */
            }
            return null;
          }
          return res.blob();
        })
        .then((blob) => {
          if (!blob || cancelled) return;
          const objUrl = URL.createObjectURL(blob);
          pdfBlobCache.set(url, objUrl);
          // Evict the oldest entry if we're holding too many papers
          // in memory — each blob can be a few MB.
          if (pdfBlobCache.size > PDF_BLOB_CACHE_SIZE) {
            const firstKey = pdfBlobCache.keys().next().value;
            if (firstKey && firstKey !== url) {
              const old = pdfBlobCache.get(firstKey);
              if (old) URL.revokeObjectURL(old);
              pdfBlobCache.delete(firstKey);
            }
          }
        })
        .catch(() => { /* background prefetch — non-fatal */ });
    }, 3000);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, cachedBlobUrl]);

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
    } else if (msg.includes("CMap") || msg.includes(" cmap") || msg.toLowerCase().includes("font")) {
      setLoadError(
        "This PDF uses fonts or encodings that could not be loaded. Try re-downloading the file from the publisher, or open it in another reader and export a new PDF.",
      );
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
              // Per audit §3.3: keep paper-scoped UI prefs in the
              // persisted store so they can be GC'd with the paper.
              setPdfScroll(paperId, +pageRatio.toFixed(4));
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
  }, [updateVisibleRange, paperId, setPdfScroll]);

  // Reset the restoration flag whenever we switch to a different paper or
  // reload the same one — the next page render should re-apply the saved
  // scroll for the new document.
  useEffect(() => {
    scrollRestoredRef.current = false;
  }, [paperId, retryKey]);

  // Normalize text from the PDF text layer before substring matching.
  // pdfjs glues glyphs back together with a mix of regular spaces,
  // non-breaking spaces, zero-width joiners, and soft hyphens; smart
  // quotes and ligatures also break naive matches against the raw
  // `selected_text`. Collapsing all whitespace to a single ASCII
  // space + unicode-normalizing + lowercasing gives us a haystack that
  // tolerates those cosmetic differences while still preserving the
  // original character offsets enough to locate the match.
  const normalizeForSearch = useCallback((s: string) => {
    return s
      .normalize("NFKC")
      .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, "") // soft hyphen, ZWJs, BOM
      .replace(/["\u201C\u201D\u2018\u2019`]/g, "'") // curly → straight quotes
      .replace(/[\u2013\u2014\u2212]/g, "-") // en/em/minus → hyphen
      .replace(/\s+/g, " ");
  }, []);

  // Paint Kindle-style underlines for every history entry found on a
  // given page. Called whenever react-pdf reports that the text layer
  // has finished rendering (via onRenderTextLayerSuccess), plus any
  // time the selectionHistory array changes. Idempotent — the first
  // step is to remove any existing overlay on the page so we never
  // stack duplicates.
  const drawUnderlinesForPage = useCallback((pageEl: HTMLElement, history: SelectionAnalysisResult[]) => {
    const textLayer = pageEl.querySelector(".react-pdf__Page__textContent, .textLayer") as HTMLElement | null;

    const peekHost = pageEl as HTMLElement & {
      __knowHighlights?: Array<{
        entry: SelectionAnalysisResult;
        rects: Array<{ x: number; y: number; w: number; h: number }>;
      }>;
    };

    if (!textLayer || history.length === 0) {
      pageEl.querySelectorAll(".know-selection-overlay").forEach((n) => n.remove());
      peekHost.__knowHighlights = [];
      return;
    }
    // pdfjs inserts the layer shell before the text spans arrive. Redrawing
    // in that window used to strip overlays first and then bail — users saw
    // highlights vanish until another mutation fired.
    if (textLayer.childElementCount === 0) return;

    const pageStyle = getComputedStyle(pageEl);
    if (pageStyle.position === "static") pageEl.style.position = "relative";

    // Build a flat string of all text-node contents under the layer
    // plus a parallel mapping from (raw index in `combined`) → the
    // text node that contains it. We search against a *normalized*
    // view of this string, but each normalized character comes from a
    // specific raw offset, which is what we actually need to feed back
    // into a DOM Range. The `normIdxToRawIdx` array records that
    // mapping 1-to-1.
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    type NodeSlice = { start: number; node: Text };
    const slices: NodeSlice[] = [];
    let combined = "";
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const text = (n as Text).data;
      if (!text) continue;
      slices.push({ start: combined.length, node: n as Text });
      combined += text;
    }
    if (!combined || slices.length === 0) {
      pageEl.querySelectorAll(".know-selection-overlay").forEach((n) => n.remove());
      peekHost.__knowHighlights = [];
      return;
    }

    // Produce the normalized view + the index mapping back to the raw
    // string index in `combined`. Each raw unit's NFKC expansion (e.g.
    // ﬁ → fi) shares the same raw index so Range boundaries still sit on
    // the original text nodes; this matches `normalizeForSearch` on the
    // stored `selected_text`, which is already NFKC-normalized.
    const zapRe = /[\u00AD\u200B-\u200D\uFEFF]/;
    const quoteMap: Record<string, string> = { "\u201C": "'", "\u201D": "'", "\u2018": "'", "\u2019": "'", "`": "'", "\"": "'" };
    const dashMap: Record<string, string> = { "\u2013": "-", "\u2014": "-", "\u2212": "-" };
    let normalized = "";
    const normIdxToRawIdx: number[] = [];
    for (let i = 0; i < combined.length; i++) {
      const ch = combined[i];
      if (zapRe.test(ch)) continue;
      const expandedChunk = ch.normalize("NFKC");
      for (let k = 0; k < expandedChunk.length; k++) {
        const ech = expandedChunk[k];
        if (zapRe.test(ech)) continue;
        let out = ech;
        if (quoteMap[out]) out = quoteMap[out];
        else if (dashMap[out]) out = dashMap[out];
        else if (/\s/.test(ech)) {
          // Collapse runs of whitespace in the normalized view so a
          // single " " in the needle matches any whitespace run in the
          // haystack. We still record the mapping back to the *first*
          // whitespace char's raw offset so ranges start/end cleanly.
          if (normalized.endsWith(" ")) continue;
          out = " ";
        }
        normalized += out.toLowerCase();
        normIdxToRawIdx.push(i);
      }
    }
    if (!normalized) {
      pageEl.querySelectorAll(".know-selection-overlay").forEach((n) => n.remove());
      peekHost.__knowHighlights = [];
      return;
    }

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const locate = (rawFlat: number) => {
      for (let i = slices.length - 1; i >= 0; i--) {
        if (slices[i].start <= rawFlat) {
          return { node: slices[i].node, offset: Math.min(rawFlat - slices[i].start, slices[i].node.data.length) };
        }
      }
      return null;
    };

    pageEl.querySelectorAll(".know-selection-overlay").forEach((n) => n.remove());

    const overlay = document.createElement("div");
    overlay.className = "know-selection-overlay";
    const pageRect = pageEl.getBoundingClientRect();

    // Per-highlight rect geometry, recorded in page-local coordinates
    // so the delegated click handler below can hit-test a click
    // against each saved selection without re-measuring the DOM.
    const pageHits: Array<{
      entry: SelectionAnalysisResult;
      rects: Array<{ x: number; y: number; w: number; h: number }>;
    }> = [];

    const seenRanges: Array<[number, number]> = [];
    // Helper: would the candidate range collide with one we already
    // painted on this page? Two highlights for *different* selections
    // routinely re-resolve to the same first hit when their starting
    // anchors share words ("the quick brown fox" and "the quick red
    // fox" both hit "the quick" first). Letting that happen meant the
    // 2nd, 3rd, ... selections quietly stacked on top of the 1st and
    // never appeared on the actual passage the user highlighted, which
    // is the "subsequent highlights aren't properly highlighted" bug.
    // We now treat any range that is fully covered (or near-covered) by
    // a prior range as a duplicate and re-search from past it.
    const coveredByPrior = (s: number, e: number) => {
      for (const [ps, pe] of seenRanges) {
        const overlap = Math.min(e, pe) - Math.max(s, ps);
        if (overlap > 0 && overlap >= (e - s) * 0.6) return true;
      }
      return false;
    };

    let painted = 0;
    for (let i = 0; i < history.length && painted < 32; i++) {
      const entry = history[i];
      const raw = entry.selected_text?.trim();
      if (!raw || raw.length < 4) continue;

      // Needle is normalized the same way as the haystack so ligatures,
      // smart quotes, and em-dashes from the LLM-submitted text don't
      // silently miss the PDF's rendering of the same passage.
      const needleNorm = normalizeForSearch(raw).toLowerCase();
      if (needleNorm.length < 4) continue;

      // Match strategy:
      //
      //   1. Try the full needle. PDF extraction is rarely *that*
      //      well-behaved — ligatures, column breaks, and embedded
      //      footnotes routinely fragment the middle of a sentence.
      //   2. If that fails, find an anchor at the *start* (first
      //      5-ish words) AND at the *end* (last 5-ish words), then
      //      highlight the range between them. This covers what the
      //      user actually selected even if the middle text doesn't
      //      line up, which was the root cause of selections being
      //      under-highlighted (only the first few words showed up).
      //   3. As a final fallback, highlight just the start anchor so
      //      something is always visible for every history entry.
      //
      // Whitespace is matched as `\s*` (zero-or-more) rather than the
      // stricter `\s+` so "intelligence(AI)" in the PDF matches
      // "intelligence AI" in the needle — parentheses and other
      // punctuation often sit flush against neighbouring words in
      // extracted text.
      const fullWords = needleNorm.split(" ").filter(Boolean);
      if (fullWords.length === 0) continue;

      const buildPattern = (words: string[]): RegExp | null => {
        try {
          return new RegExp(words.map(escapeRe).join("\\W*"), "i");
        } catch {
          return null;
        }
      };

      let normStart = -1;
      let normEnd = -1;

      // 1. Full-needle match. Iterate matches and pick the first one
      // that doesn't collide with what we've already painted —
      // necessary when the same phrase appears multiple times on a
      // page (common in introductions / abstracts where the LLM
      // sometimes echoes a phrase verbatim).
      const fullPatternG = (() => {
        try { return new RegExp(fullWords.map(escapeRe).join("\\W*"), "gi"); }
        catch { return null; }
      })();
      if (fullPatternG) {
        let m: RegExpExecArray | null;
        while ((m = fullPatternG.exec(normalized)) !== null) {
          const ns = m.index;
          const ne = ns + m[0].length;
          // Translate to raw offsets so the dedupe check uses the same
          // coordinate space as `seenRanges`.
          const rs = normIdxToRawIdx[ns];
          const reEnd = normIdxToRawIdx[Math.min(ne - 1, normIdxToRawIdx.length - 1)] + 1;
          if (!coveredByPrior(rs, reEnd)) {
            normStart = ns;
            normEnd = ne;
            break;
          }
          if (m.index === fullPatternG.lastIndex) fullPatternG.lastIndex++;
        }
      }
      if (normStart < 0 && fullWords.length >= 4) {
        // 2. Anchor-based bracket match. Take enough words on each
        //    side that the match is unlikely to hit the wrong place,
        //    but not so many that the PDF's own fragmentation
        //    disqualifies them.
        const anchorLen = Math.min(5, Math.max(3, Math.floor(fullWords.length / 3)));
        const startAnchor = fullWords.slice(0, anchorLen);
        const endAnchor = fullWords.slice(-anchorLen);
        const startPattern = buildPattern(startAnchor);
        const startHit = startPattern ? startPattern.exec(normalized) : null;
        if (startHit && startHit.index != null) {
          const anchorStartIdx = startHit.index;
          const anchorStartEnd = anchorStartIdx + startHit[0].length;

          // Find the end anchor *after* the start anchor so a
          // repeated phrase doesn't wrap the match back on itself.
          const endPattern = buildPattern(endAnchor);
          if (endPattern) {
            endPattern.lastIndex = anchorStartEnd;
            // Exec from the remaining substring; use a fresh regex
            // instance so lastIndex semantics are predictable.
            const tail = normalized.slice(anchorStartEnd);
            const endHit = endPattern.exec(tail);
            if (endHit && endHit.index != null) {
              normStart = anchorStartIdx;
              normEnd = anchorStartEnd + endHit.index + endHit[0].length;
            }
          }
          // 3. Fallback: start-anchor only.
          if (normStart < 0) {
            normStart = anchorStartIdx;
            normEnd = anchorStartEnd;
          }
        }
      }

      if (normStart < 0 || normEnd <= normStart) continue;
      if (normEnd > normIdxToRawIdx.length) continue;

      const rawStart = normIdxToRawIdx[normStart];
      // End is exclusive — grab the raw offset after the last matched
      // normalized char.
      const rawEndInclusive = normIdxToRawIdx[normEnd - 1];
      const rawEnd = rawEndInclusive + 1;

      // Skip *only* near-duplicate ranges (≥60% overlap with a prior
      // one for the same passage). Two genuinely different selections
      // that happen to brush each other are still both painted —
      // letting them stack keeps the "Selections" tab a faithful map
      // of what the user has analysed, which is the core promise.
      if (coveredByPrior(rawStart, rawEnd)) continue;
      seenRanges.push([rawStart, rawEnd]);

      const startLoc = locate(rawStart);
      const endLoc = locate(rawEnd);
      if (!startLoc || !endLoc) continue;

      const range = document.createRange();
      try {
        range.setStart(startLoc.node, startLoc.offset);
        range.setEnd(endLoc.node, endLoc.offset);
      } catch {
        continue;
      }
      const rects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0.5 && r.height > 0.5,
      );
      if (rects.length === 0) continue;

      // Paint the underline bars themselves. These stay
      // `pointer-events: none` (see globals.css) so starting a new
      // text selection that overlaps an existing highlight still
      // works natively. The whole underline is nonetheless made
      // *clickable* via a delegated handler on `pageEl` further down:
      // we record each highlight's page-local rect geometry on
      // `pageHits` and resolve a click back to its entry by point
      // testing. This is the pattern that finally fixes "nothing
      // happens when I click my highlights" — the old pill was too
      // small for users to find.
      const action = normalizeSelectionAction(entry.action);
      const localRects: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const r of rects) {
        const div = document.createElement("div");
        div.className = "know-selection-underline";
        // `data-action` drives the per-action highlight tint declared
        // in globals.css. Falling back to "explain" preserves the
        // original blue for any legacy cached entries that pre-date
        // the action field.
        div.setAttribute("data-action", action);
        const x = r.left - pageRect.left;
        const y = r.top - pageRect.top;
        div.style.left = `${x}px`;
        div.style.top = `${y}px`;
        div.style.width = `${r.width}px`;
        div.style.height = `${r.height}px`;
        overlay.appendChild(div);
        localRects.push({ x, y, w: r.width, h: r.height });
      }
      pageHits.push({ entry, rects: localRects });

      painted++;
    }

    // Delegated click / double-click / contextmenu on pageEl —
    // geometric hit-testing against underline rects only (no overlay
    // pill). Single-click opens after a short delay so double-click can
    // show delete UI without opening the sidebar first.
    type KnowPageHost = HTMLElement & {
      __knowClickAttached?: boolean;
      __knowHighlights?: Array<{
        entry: SelectionAnalysisResult;
        rects: Array<{ x: number; y: number; w: number; h: number }>;
      }>;
      __knowResolveHighlight?: (
        ev: Pick<PointerEvent | MouseEvent, "clientX" | "clientY">,
      ) => SelectionAnalysisResult | null;
      __knowPendingOpenTimer?: ReturnType<typeof setTimeout> | null;
      __knowPdKey?: string;
      __knowPdTs?: number;
    };
    const hostEl = pageEl as KnowPageHost;
    hostEl.__knowHighlights = pageHits;
    if (!hostEl.__knowClickAttached) {
      hostEl.__knowClickAttached = true;
      hostEl.__knowPendingOpenTimer = null;

      hostEl.__knowResolveHighlight = (ev): SelectionAnalysisResult | null => {
        const hits = hostEl.__knowHighlights;
        if (!hits || hits.length === 0) return null;
        const r = hostEl.getBoundingClientRect();
        const pad = 3;
        const x = ev.clientX - r.left;
        const y = ev.clientY - r.top;
        for (const h of hits) {
          for (const rr of h.rects) {
            if (
              x >= rr.x - pad &&
              x <= rr.x + rr.w + pad &&
              y >= rr.y - pad &&
              y <= rr.y + rr.h + pad
            ) {
              return h.entry;
            }
          }
        }
        return null;
      };

      const deleteHighlightEntry = (entry: SelectionAnalysisResult) => {
        removeSelectionFromHistory(entry);
        if (paperId) {
          void api
            .deleteSelection(paperId, entry.selected_text ?? "", entry.action ?? "explain")
            .then((res) => {
              const ids = res.removed_note_ids;
              if (!ids?.length) return;
              for (const nid of ids) {
                useStore.getState().removeNote(nid);
              }
            })
            .catch(() => {});
        }
      };

      hostEl.addEventListener(
        "pointerdown",
        (ev: PointerEvent) => {
          if (ev.pointerType !== "mouse" || ev.button !== 0) return;
          const resolve = hostEl.__knowResolveHighlight;
          if (!resolve) return;
          const entry = resolve(ev);
          if (!entry) {
            hostEl.__knowPdKey = "";
            return;
          }
          const key = highlightPointerKey(entry);
          const now = performance.now();
          if (
            key === hostEl.__knowPdKey &&
            typeof hostEl.__knowPdTs === "number" &&
            now - hostEl.__knowPdTs < 450
          ) {
            ev.preventDefault();
            ev.stopPropagation();
            if (hostEl.__knowPendingOpenTimer != null) {
              clearTimeout(hostEl.__knowPendingOpenTimer);
              hostEl.__knowPendingOpenTimer = null;
            }
            hostEl.__knowPdKey = "";
            hostEl.__knowPdTs = undefined;
            openSelectionDeletePopover(ev.clientX, ev.clientY, () => {
              deleteHighlightEntry(entry);
            });
            return;
          }
          hostEl.__knowPdKey = key;
          hostEl.__knowPdTs = now;
        },
        true,
      );

      hostEl.addEventListener("click", (ev) => {
        const resolve = hostEl.__knowResolveHighlight;
        if (!resolve) return;
        const entry = resolve(ev);
        if (!entry) return;

        if (ev.shiftKey) {
          if (hostEl.__knowPendingOpenTimer != null) {
            clearTimeout(hostEl.__knowPendingOpenTimer);
            hostEl.__knowPendingOpenTimer = null;
          }
          ev.stopPropagation();
          ev.preventDefault();
          deleteHighlightEntry(entry);
          return;
        }

        if (ev.detail >= 2) {
          if (hostEl.__knowPendingOpenTimer != null) {
            clearTimeout(hostEl.__knowPendingOpenTimer);
            hostEl.__knowPendingOpenTimer = null;
          }
          ev.stopPropagation();
          ev.preventDefault();
          return;
        }

        ev.stopPropagation();
        ev.preventDefault();
        if (hostEl.__knowPendingOpenTimer != null) clearTimeout(hostEl.__knowPendingOpenTimer);
        hostEl.__knowPendingOpenTimer = setTimeout(() => {
          hostEl.__knowPendingOpenTimer = null;
          openSelectionFromHistory(entry);
        }, 280);
      });

      hostEl.addEventListener("dblclick", (ev) => {
        const resolve = hostEl.__knowResolveHighlight;
        if (!resolve) return;
        const entry = resolve(ev);
        if (!entry) return;
        if (hostEl.__knowPendingOpenTimer != null) {
          clearTimeout(hostEl.__knowPendingOpenTimer);
          hostEl.__knowPendingOpenTimer = null;
        }
        ev.preventDefault();
        ev.stopPropagation();
        openSelectionDeletePopover(ev.clientX, ev.clientY, () => {
          deleteHighlightEntry(entry);
        });
      });

      hostEl.addEventListener("contextmenu", (ev) => {
        const resolve = hostEl.__knowResolveHighlight;
        if (!resolve) return;
        const entry = resolve(ev);
        if (!entry) return;
        ev.preventDefault();
        ev.stopPropagation();
        deleteHighlightEntry(entry);
      });

      // Visual cursor affordance: swap to `pointer` while the
      // cursor is over any known highlight rect so users get
      // immediate feedback that the underline is interactive.
      // Restoring the cursor to `auto` as soon as they leave is
      // what differentiates "text selection region" from "click to
      // open" in reader UIs.
      hostEl.addEventListener("mousemove", (ev) => {
        const hits = hostEl.__knowHighlights;
        if (!hits || hits.length === 0) {
          if (hostEl.style.cursor === "pointer") hostEl.style.cursor = "";
          return;
        }
        const r = hostEl.getBoundingClientRect();
        const pad = 3;
        const x = ev.clientX - r.left;
        const y = ev.clientY - r.top;
        let over = false;
        outer: for (const h of hits) {
          for (const rr of h.rects) {
            if (
              x >= rr.x - pad &&
              x <= rr.x + rr.w + pad &&
              y >= rr.y - pad &&
              y <= rr.y + rr.h + pad
            ) {
              over = true;
              break outer;
            }
          }
        }
        const desired = over ? "pointer" : "";
        if (hostEl.style.cursor !== desired) hostEl.style.cursor = desired;
      });
    }

    if (overlay.childElementCount > 0) pageEl.appendChild(overlay);
  }, [openSelectionFromHistory, removeSelectionFromHistory, normalizeForSearch, paperId]);

  // Fallback repaint: when the selectionHistory array changes while
  // pages are already on screen, walk every mounted page and redraw.
  // We also listen for MutationObserver-level changes to the container
  // (e.g. text-layer nodes being appended *after* onRenderSuccess, or
  // react-pdf re-rendering a virtualized page) so new underlines
  // appear without waiting on the next explicit render cycle.
  //
  // IMPORTANT: `drawUnderlinesForPage` appends `.know-selection-overlay`
  // inside each `.react-pdf__Page`. Observers on the page subtree must
  // ignore those mutations — otherwise remove+append each frame fires
  // another mutation → rAF redraw → infinite main-thread loop (tab
  // switches that resize the pane make this very noticeable).
  //
  // Why both the container observer AND per-page observers:
  //   • pdfjs inserts the ``.textLayer`` container first and then
  //     streams spans into it over the next few animation frames.
  //     Catching only the "text layer appeared" event means we'd
  //     paint zero underlines (no spans yet) and not try again.
  //   • A per-page observer lets us re-run the draw whenever the
  //     *span count* inside the text layer changes, which is the
  //     precise moment the draw can actually succeed.
  //   • The container observer handles page re-mounts that happen
  //     during scroll virtualisation; it arms a per-page observer as
  //     soon as the text layer appears.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pageObservers = new Map<HTMLElement, MutationObserver>();
    let raf: number | null = null;
    let pending = new Set<HTMLElement>();

    const drainPending = () => {
      raf = null;
      const items = Array.from(pending);
      pending = new Set();
      for (const el of items) {
        drawUnderlinesForPage(el, selectionHistory);
      }
    };
    const schedulePage = (pageEl: HTMLElement) => {
      pending.add(pageEl);
      if (raf === null) raf = requestAnimationFrame(drainPending);
    };
    const scheduleAll = () => {
      container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]").forEach(schedulePage);
    };

    const armPage = (pageEl: HTMLElement) => {
      if (pageObservers.has(pageEl)) return;
      const inner = () => {
        schedulePage(pageEl);
      };
      // Observe the entire page element — text layer gets appended
      // later, so a subtree-level observer is the only way to catch
      // both the initial insertion and every subsequent span update.
      const mo = new MutationObserver((recs) => {
        if (mutationAffectsPdfTextLayer(recs)) inner();
      });
      mo.observe(pageEl, { subtree: true, childList: true, characterData: true });
      pageObservers.set(pageEl, mo);
      schedulePage(pageEl);
    };

    // Arm observers on every already-mounted page and schedule an
    // initial draw so history that arrived before the pages did still
    // gets painted as soon as the text layer fills in.
    container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]").forEach(armPage);
    scheduleAll();

    // Top-level observer: notice when React mounts a new Page element
    // (scroll-back into a virtualised page) and arm a per-page
    // observer for it.
    const top = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== "childList") continue;
        for (const n of Array.from(m.addedNodes)) {
          if (!(n instanceof Element)) continue;
          if (n.classList?.contains("react-pdf__Page")) {
            armPage(n as HTMLElement);
          } else {
            n.querySelectorAll?.<HTMLElement>(".react-pdf__Page[data-page-number]").forEach(armPage);
          }
        }
        for (const n of Array.from(m.removedNodes)) {
          if (!(n instanceof Element)) continue;
          const el = n as HTMLElement;
          const obs = pageObservers.get(el);
          if (obs) { obs.disconnect(); pageObservers.delete(el); }
        }
      }
    });
    top.observe(container, { subtree: true, childList: true });

    const resizeRo = new ResizeObserver(() => scheduleAll());
    resizeRo.observe(container);

    return () => {
      resizeRo.disconnect();
      top.disconnect();
      pageObservers.forEach((m) => m.disconnect());
      pageObservers.clear();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [selectionHistory, drawUnderlinesForPage, scale]);

  const handlePageRender = useCallback((pageNum: number) => {
    const el = containerRef.current?.querySelector(`[data-page-number="${pageNum}"]`) as HTMLElement | null;
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
      const savedRatio = savedScrollByPaper[paperId] || 0;
      if (savedRatio > 0 && Number.isFinite(savedRatio)) {
        const pageStride = pageHeightRef.current + PAGE_GAP;
        const target = Math.round(savedRatio * pageStride);
        container.scrollTop = target;
        // Nudge visibleRange so the target pages actually render —
        // relying purely on the scroll event is flaky when React batches
        // the update with the initial paint.
        updateVisibleRange();
      }
      scrollRestoredRef.current = true;
    }
  }, [updateVisibleRange, paperId, savedScrollByPaper]);

  // Called by react-pdf when the *text layer* finishes rendering (as
  // opposed to onRenderSuccess, which fires after the canvas but
  // sometimes *before* spans have been appended to the text layer).
  // Drawing underlines here is the most reliable point — the text
  // nodes we search over are guaranteed to be present.
  const handleTextLayerRendered = useCallback((pageNum: number) => {
    const el = containerRef.current?.querySelector(`.react-pdf__Page[data-page-number="${pageNum}"]`) as HTMLElement | null;
    if (!el) return;
    drawUnderlinesForPage(el, useStore.getState().selectionHistory);
  }, [drawUnderlinesForPage]);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.toString().trim()) {
      onSelectionClear?.();
      return;
    }

    // Snap outward to whole words before reading the text. Apple Books /
    // Kindle / SciSpace all do this; without it, mid-word releases produce
    // ragged selections and the toolbar fires with truncated tokens.
    const liveRange = sel.getRangeAt(0);
    const snapped = snapRangeToWords(liveRange);
    if (snapped) {
      sel.removeAllRanges();
      sel.addRange(snapped);
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

    // Re-read the rect from the (possibly snapped) range so the toolbar
    // anchors to the new selection, not the pre-snap drag endpoint.
    const range = sel.getRangeAt(0);
    const rect = snapshotDomRect(unionBoundingRectFromRange(range));
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

  const zoomFieldDirty = useRef(false);
  const displayedPercent = Math.round((scale / BASELINE_SCALE) * 100);
  const [zoomField, setZoomField] = useState(String(displayedPercent));

  useEffect(() => {
    if (!zoomFieldDirty.current) setZoomField(String(displayedPercent));
  }, [displayedPercent]);

  const applyZoomFromField = useCallback(() => {
    zoomFieldDirty.current = false;
    const raw = zoomField.replace(/%/g, "").trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) {
      setZoomField(String(displayedPercent));
      return;
    }
    const pct = Math.min(300, Math.max(40, Math.round(n)));
    let next = BASELINE_SCALE * (pct / 100);
    next = Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, Math.round(next * 1000) / 1000));
    setScale(next);
    setZoomField(String(Math.round((next / BASELINE_SCALE) * 100)));
  }, [zoomField, displayedPercent]);

  const zoomIn = () => {
    zoomFieldDirty.current = false;
    setScale((s) => Math.min(MAX_ZOOM_SCALE, Math.round((s + 0.2) * 100) / 100));
  };
  const zoomOut = () => {
    zoomFieldDirty.current = false;
    setScale((s) => Math.max(MIN_ZOOM_SCALE, Math.round((s - 0.2) * 100) / 100));
  };
  const zoomReset = () => {
    zoomFieldDirty.current = false;
    setScale(BASELINE_SCALE);
  };

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
      <div
        className={`shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border glass-subtle ${
          reserveToolbarRightForOverlay ? "pr-[3.25rem] sm:pr-[3.75rem]" : ""
        }`}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={zoomOut}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-all text-[15px]"
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <div className="flex h-7 items-center gap-0.5 rounded-lg border border-border/60 bg-background/50 px-1">
            <input
              value={zoomField}
              onChange={(e) => {
                zoomFieldDirty.current = true;
                setZoomField(e.target.value);
              }}
              onKeyDown={(e) => e.key === "Enter" && applyZoomFromField()}
              onBlur={applyZoomFromField}
              type="text"
              inputMode="decimal"
              name="know_pdf_zoom_percent"
              autoComplete="off"
              className="w-10 bg-transparent text-center text-[11px] font-mono text-foreground outline-none"
              title="Zoom % (100 = default reading size). Press Enter or click away."
              aria-label="Zoom percentage"
            />
            <span className="pr-0.5 text-[10px] text-muted-foreground/80">%</span>
          </div>
          <button
            type="button"
            onClick={zoomReset}
            className="h-7 px-1.5 flex items-center justify-center rounded-lg text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-all font-medium"
            title="Reset zoom to default reading size"
            aria-label="Reset zoom"
          >
            Reset
          </button>
          <button
            type="button"
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
              className="w-11 tabular text-center rounded-md border border-input bg-background/95 text-[11px] text-foreground shadow-[var(--shadow-xs)] backdrop-blur-sm transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 py-1"
            />
            <span>/ {numPages}</span>
          </div>
        )}

        <div className="flex-1" />

        <span className="text-[10px] text-muted-foreground/85 text-right max-sm:hidden">
          <span className="text-muted-foreground/50">Drag to select text · floating actions attach to what you highlighted</span>
        </span>
      </div>

      {/* PDF Pages */}
      <div
        ref={containerRef}
        data-know-pdf-scroll
        className="relative flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-900"
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
            options={documentOptions}
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
                    devicePixelRatio={canvasDpr}
                    className="shadow-lg bg-card"
                    renderTextLayer={true}
                    renderAnnotationLayer={true}
                    onRenderSuccess={() => handlePageRender(pageNum)}
                    onRenderTextLayerSuccess={() => handleTextLayerRendered(pageNum)}
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
