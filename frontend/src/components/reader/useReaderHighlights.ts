"use client";

import { useEffect, useState, type RefObject } from "react";
import { useStore, EMPTY_HIGHLIGHTS_LIST } from "@/lib/store";

const BANNER_KEY = "know:pdf-region-highlight-banner";

/**
 * Text highlights work via native selection. PDF-coordinate highlights
 * only apply to the original PDF view — show a one-time banner here.
 */
export function useReaderHighlights(
  paperId: string,
  containerRef: RefObject<HTMLElement | null>,
) {
  const regionCount = useStore(
    (s) => (s.pdfRegionHighlightsByPaper[paperId] ?? []).length,
  );
  const textHighlights = useStore(
    (s) => s.highlightsByPaper[paperId] ?? EMPTY_HIGHLIGHTS_LIST,
  );
  const [bannerDismissed, setBannerDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setBannerDismissed(window.localStorage.getItem(`${BANNER_KEY}:${paperId}`) === "1");
  }, [paperId]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !textHighlights.length) return;

    const applyHighlights = () => {
      // Strip any prior highlight wraps so re-runs don't compound.
      root
        .querySelectorAll("mark[data-reader-highlight]")
        .forEach((mark) => {
          const parent = mark.parentNode;
          if (!parent) return;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
        });
      for (const h of textHighlights) {
        const needle = (h.selected_text || "").trim();
        if (needle.length < 8) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = node.textContent || "";
          const idx = text.indexOf(needle);
          if (idx < 0) continue;
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + needle.length);
          const mark = document.createElement("mark");
          mark.dataset.readerHighlight = "true";
          mark.className = "rounded-sm px-0.5";
          mark.style.backgroundColor = `${h.color}44`;
          try {
            range.surroundContents(mark);
          } catch {
            /* overlapping ranges — skip */
          }
          break;
        }
      }
    };

    // Try immediately, then once again on the next animation frame,
    // then again after a short delay. Streamdown sometimes mounts its
    // blocks lazily, so the initial tree walk runs against an
    // incomplete DOM. (Avoid a MutationObserver — applyHighlights
    // mutates the DOM, which would trigger an infinite loop.)
    applyHighlights();
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame(() => applyHighlights())
        : 0;
    const timeoutId = window.setTimeout(applyHighlights, 800);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(timeoutId);
    };
  }, [containerRef, textHighlights]);

  const dismissBanner = () => {
    setBannerDismissed(true);
    window.localStorage.setItem(`${BANNER_KEY}:${paperId}`, "1");
  };

  const showBanner = !bannerDismissed && regionCount > 0;

  return { showBanner, dismissBanner };
}
