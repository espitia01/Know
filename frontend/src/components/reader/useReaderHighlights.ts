"use client";

import { useEffect, useState, type RefObject } from "react";
import { useStore } from "@/lib/store";

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
  const textHighlights = useStore((s) => s.highlightsByPaper[paperId] ?? []);
  const [bannerDismissed, setBannerDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setBannerDismissed(window.localStorage.getItem(`${BANNER_KEY}:${paperId}`) === "1");
  }, [paperId]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !textHighlights.length) return;

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
  }, [containerRef, textHighlights]);

  const dismissBanner = () => {
    setBannerDismissed(true);
    window.localStorage.setItem(`${BANNER_KEY}:${paperId}`, "1");
  };

  const showBanner = !bannerDismissed && regionCount > 0;

  return { showBanner, dismissBanner };
}
