"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { api, getAuthHeadersSync } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useReaderHighlights } from "./useReaderHighlights";

const math = createMathPlugin({ singleDollarTextMath: true });
const STREAMDOWN_PLUGINS = { math, code };

const OCR_IMAGE_RE = /p\d+-img-\d+\.png/g;
const ocrBlobCache = new Map<string, string>();

async function hydrateMarkdownImages(
  markdown: string,
  paperId: string,
  trial: boolean,
): Promise<string> {
  const ids = [...new Set(markdown.match(OCR_IMAGE_RE) ?? [])];
  if (!ids.length) return markdown;

  const headers = trial ? undefined : getAuthHeadersSync();
  let out = markdown;
  await Promise.all(
    ids.map(async (id) => {
      const cacheKey = `${paperId}:${id}`;
      let blobUrl = ocrBlobCache.get(cacheKey);
      if (!blobUrl) {
        const res = await fetch(api.getOcrImageUrl(paperId, id, trial), { headers });
        if (!res.ok) return;
        const blob = await res.blob();
        blobUrl = URL.createObjectURL(blob);
        ocrBlobCache.set(cacheKey, blobUrl);
      }
      out = out.replaceAll(id, blobUrl);
    }),
  );
  return out;
}

export interface MarkdownReaderProps {
  paperId: string;
  trial?: boolean;
  onTextSelected?: (text: string, rect: DOMRect) => void;
  onSelectionClear?: () => void;
}

export function MarkdownReader({
  paperId,
  trial = false,
  onTextSelected,
  onSelectionClear,
}: MarkdownReaderProps) {
  const markdownByPaper = useStore((s) => s.markdownByPaper);
  const setPaperMarkdown = useStore((s) => s.setPaperMarkdown);
  const entry = markdownByPaper[paperId];
  const containerRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(!entry);
  const [error, setError] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const { showBanner, dismissBanner } = useReaderHighlights(paperId, containerRef);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    const load = async () => {
      try {
        let payload = entry;
        if (!payload) {
          payload = trial ? await api.getTrialPaperMarkdown(paperId) : await api.getPaperMarkdown(paperId);
          if (!cancelled) setPaperMarkdown(paperId, payload);
        }

        if (
          !trial &&
          payload.ocr_status !== "ready" &&
          payload.ocr_status !== "unsupported" &&
          !payload.markdown?.trim()
        ) {
          void api.runPaperOcr(paperId).catch(() => undefined);
        }

        const rawPages = payload.page_markdown?.length
          ? payload.page_markdown
          : payload.markdown
            ? [payload.markdown]
            : [];

        const hydrated = await Promise.all(
          rawPages.map((page) => hydrateMarkdownImages(page, paperId, trial)),
        );

        if (!cancelled) {
          setPages(hydrated);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load paper");
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [paperId, trial, entry, setPaperMarkdown]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        onSelectionClear?.();
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        onSelectionClear?.();
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2) {
        onSelectionClear?.();
        return;
      }
      const rect = range.getBoundingClientRect();
      onTextSelected?.(text, rect);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [onTextSelected, onSelectionClear]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || pages.length < 2) return;

    const sections = root.querySelectorAll<HTMLElement>("section[data-page]");
    if (!sections.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target instanceof HTMLElement) {
          const page = Number(visible.target.dataset.page);
          if (page > 0) setCurrentPage(page);
        }
      },
      { root, threshold: [0.2, 0.5, 0.8] },
    );

    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [pages]);

  const rendered = useMemo(() => {
    if (!pages.length) return null;
    if (pages.length === 1) {
      return (
        <Streamdown plugins={STREAMDOWN_PLUGINS} mode="static" controls={false} parseIncompleteMarkdown={false}>
          {pages[0]}
        </Streamdown>
      );
    }
    return pages.map((body, i) => (
      <section key={i + 1} data-page={i + 1} className="scroll-mt-6">
        <Streamdown plugins={STREAMDOWN_PLUGINS} mode="static" controls={false} parseIncompleteMarkdown={false}>
          {body}
        </Streamdown>
      </section>
    ));
  }, [pages]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-sm)] text-muted-foreground">
        Preparing readable view…
      </div>
    );
  }

  if (error || !pages.length) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[var(--text-sm)] text-muted-foreground">
        {error || "No readable content yet."}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {showBanner && (
        <div className="border-b border-border/40 bg-muted/[0.08] px-4 py-2 text-[var(--text-xs)] text-muted-foreground">
          Highlights saved with PDF coordinates appear in the original PDF view. Text highlights are shown here when
          we can match the passage.
          <button type="button" onClick={dismissBanner} className="ml-2 underline hover:text-foreground">
            Dismiss
          </button>
        </div>
      )}
      {pages.length > 1 && (
        <div className="sticky top-0 z-10 border-b border-border/40 bg-background/90 px-4 py-2 text-[var(--text-xs)] tabular-nums text-muted-foreground backdrop-blur-sm">
          Page {currentPage} of {pages.length}
        </div>
      )}
      <div
        ref={containerRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-y-contain",
          "[scrollbar-gutter:stable]",
        )}
      >
        <article className="prose prose-neutral dark:prose-invert mx-auto max-w-3xl px-6 py-8 font-display analysis-content">
          {rendered}
        </article>
      </div>
    </div>
  );
}
