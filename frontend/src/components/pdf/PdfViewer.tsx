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

  // Background-download the full PDF after the first paint so the next
  // time the user opens this paper it loads from the in-memory cache.
  // We don't block on this — the visible render is already using the
  // range-request URL above.
  useEffect(() => {
    if (!url || cachedBlobUrl) return;
    let cancelled = false;
    const controller = new AbortController();
    // Small delay so we don't compete with PDF.js' own range requests
    // for the first render — just priming the cache for next time.
    const timer = setTimeout(() => {
      fetch(url, {
        headers: getAuthHeadersSync(),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.blob() : null))
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
    }, 800);
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

    pageEl.querySelectorAll(".know-selection-overlay").forEach((n) => n.remove());
    if (!textLayer || history.length === 0) return;
    // Bail if pdfjs hasn't populated text spans yet. The container div
    // gets inserted before the individual spans, so redrawing here
    // would walk zero nodes, paint nothing, and then we'd wait until
    // the next mutation to try again. Better to just no-op.
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
    if (!combined || slices.length === 0) return;

    // Produce the normalized view + the index mapping back to the raw
    // string. We walk char-by-char so normalization never shifts offset
    // alignment (apart from characters we intentionally strip, whose
    // raw offsets simply don't appear in the map).
    const zapRe = /[\u00AD\u200B-\u200D\uFEFF]/;
    const quoteMap: Record<string, string> = { "\u201C": "'", "\u201D": "'", "\u2018": "'", "\u2019": "'", "`": "'", "\"": "'" };
    const dashMap: Record<string, string> = { "\u2013": "-", "\u2014": "-", "\u2212": "-" };
    let normalized = "";
    const normIdxToRawIdx: number[] = [];
    for (let i = 0; i < combined.length; i++) {
      const ch = combined[i];
      if (zapRe.test(ch)) continue;
      let out = ch;
      if (quoteMap[ch]) out = quoteMap[ch];
      else if (dashMap[ch]) out = dashMap[ch];
      else if (/\s/.test(ch)) {
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
    if (!normalized) return;

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const locate = (rawFlat: number) => {
      for (let i = slices.length - 1; i >= 0; i--) {
        if (slices[i].start <= rawFlat) {
          return { node: slices[i].node, offset: Math.min(rawFlat - slices[i].start, slices[i].node.data.length) };
        }
      }
      return null;
    };

    const overlay = document.createElement("div");
    overlay.className = "know-selection-overlay";
    const pageRect = pageEl.getBoundingClientRect();

    const seenRanges: Array<[number, number]> = [];
    let painted = 0;
    for (let i = 0; i < history.length && painted < 16; i++) {
      const entry = history[i];
      const raw = entry.selected_text?.trim();
      if (!raw || raw.length < 4) continue;

      // Needle is normalized the same way as the haystack so ligatures,
      // smart quotes, and em-dashes from the LLM-submitted text don't
      // silently miss the PDF's rendering of the same passage.
      const needleNorm = normalizeForSearch(raw).toLowerCase();
      if (needleNorm.length < 4) continue;

      // Build a tolerant pattern: any whitespace run in the needle can
      // match a run in the haystack. We try progressively shorter
      // prefixes if the full needle doesn't hit — PDF extraction
      // sometimes drops the tail of a long selection (page breaks,
      // footnote interruptions, column crossings), and a match on the
      // first clause of the sentence is still better than nothing.
      const fullWords = needleNorm.split(" ").filter(Boolean);
      if (fullWords.length === 0) continue;

      const candidateWindows: string[][] = [fullWords];
      if (fullWords.length > 10) candidateWindows.push(fullWords.slice(0, 10));
      if (fullWords.length > 6) candidateWindows.push(fullWords.slice(0, 6));
      if (fullWords.length > 4) candidateWindows.push(fullWords.slice(0, 4));

      let m: RegExpExecArray | null = null;
      for (const w of candidateWindows) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(w.map(escapeRe).join("\\s+"), "i");
        } catch {
          continue;
        }
        const hit = pattern.exec(normalized);
        if (hit) { m = hit; break; }
      }
      if (!m || m.index == null) continue;
      const normStart = m.index;
      const normEnd = normStart + m[0].length;
      if (normEnd > normIdxToRawIdx.length) continue;

      const rawStart = normIdxToRawIdx[normStart];
      // End is exclusive — grab the raw offset after the last matched
      // normalized char.
      const rawEndInclusive = normIdxToRawIdx[normEnd - 1];
      const rawEnd = rawEndInclusive + 1;

      const overlaps = seenRanges.some(([s, e]) => !(rawEnd <= s || rawStart >= e));
      if (overlaps) continue;
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
  }, [openSelectionFromHistory, normalizeForSearch]);

  // Fallback repaint: when the selectionHistory array changes while
  // pages are already on screen, walk every mounted page and redraw.
  // We also listen for MutationObserver-level changes to the container
  // (e.g. text-layer nodes being appended *after* onRenderSuccess, or
  // react-pdf re-rendering a virtualized page) so new underlines
  // appear without waiting on the next explicit render cycle.
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
      const inner = () => schedulePage(pageEl);
      // Observe the entire page element — text layer gets appended
      // later, so a subtree-level observer is the only way to catch
      // both the initial insertion and every subsequent span update.
      const mo = new MutationObserver(() => inner());
      mo.observe(pageEl, { subtree: true, childList: true });
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

    return () => {
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
