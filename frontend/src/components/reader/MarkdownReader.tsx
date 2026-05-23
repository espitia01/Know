"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { api, getAuthHeadersSync } from "@/lib/api";
import { useStore } from "@/lib/store";
import { READER_FAMILY_TO_VAR } from "@/lib/readerFont";
import { selectionHasMath } from "@/lib/selectionMath";
import { cn } from "@/lib/utils";
import { OwlSpinner } from "@/components/ui/OwlSpinner";
import { useReaderHighlights } from "./useReaderHighlights";
import { ReaderFontMenu } from "./ReaderFontMenu";

const math = createMathPlugin({ singleDollarTextMath: true });
const STREAMDOWN_PLUGINS = { math, code };

const OCR_IMAGE_RE = /(?:p\d+-img-\d+|fig-\d+)\.png/g;
const ocrBlobCache = new Map<string, string>();

/**
 * Streamdown's default URL transform blocks `blob:` and `data:` URLs in
 * images, which kills our OCR figure hydration. Allow same-origin URLs,
 * blob:/data: (from the hydration cache), plus standard HTTPS sources.
 */
function readerUrlTransform(url: string): string | null {
  if (!url) return null;
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  if (url.startsWith("mailto:")) return url;
  return null;
}

/** Wrap figure caption paragraphs for journal-style styling. */
function wrapFigureCaptions(markdown: string): string {
  return markdown.replace(
    /^(Fig\.?\s+\d+[.:][^\n]*|Figure\s+\d+[.:][^\n]*)/gim,
    (line) => `<figcaption class="reader-figure-caption">${line}</figcaption>`,
  );
}

/**
 * Collapse the noisy author byline Mistral OCR emits when a paper's
 * affiliation numerals are typeset as stacked superscripts (Sci. Adv.
 * cover pages are the worst offenders). The pattern looks like:
 *
 *     Author Name
 *     1
 *     ,
 *     2
 *     1,2
 *     , Next Author
 *     3
 *     3
 *
 * which is what shows up as the visually duplicated "1 , 2 1,2" runs.
 * We treat any sequence of digit/punctuation-only lines that appear
 * immediately after a name as the affiliation marker and collapse it
 * into a single superscript-style fragment.
 */
function collapseAuthorByline(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  // Only operate on the first ~12 non-blank lines after a title — past
  // that we're definitely in the abstract / body.
  let bylineBudget = 12;
  while (i < lines.length) {
    const line = lines[i];
    if (bylineBudget <= 0) {
      out.push(line);
      i += 1;
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      i += 1;
      continue;
    }
    // Heading or section break — stop munging.
    if (/^#|^\s*Abstract\b|^\s*ABSTRACT\b|^\s*INTRODUCTION\b/.test(line)) {
      bylineBudget = 0;
      out.push(line);
      i += 1;
      continue;
    }
    // Gather any following digit/punctuation-only lines as one cluster.
    const cluster: string[] = [];
    let j = i + 1;
    const isMarkerLine = (s: string) => /^[\s\d,;*†‡§¶∗]+$/.test(s) && /\d/.test(s);
    while (j < lines.length && lines[j].trim() && isMarkerLine(lines[j])) {
      cluster.push(lines[j].trim());
      j += 1;
    }
    if (cluster.length >= 2) {
      // Dedupe identical markers ("1\n,\n2\n1,2" → "1,2").
      const compact = cluster.join(",").replace(/[^\d,]/g, "").split(",").filter(Boolean);
      const unique = Array.from(new Set(compact));
      const marker = unique.join(",");
      out.push(`${line}<sup>${marker}</sup>`);
      i = j;
      bylineBudget -= 1;
      continue;
    }
    out.push(line);
    i += 1;
    bylineBudget -= 1;
  }
  return out.join("\n");
}

/**
 * Wrap the paragraph immediately after the first H1 (typically the
 * author byline) in a `.reader-byline` class so the byline gets its
 * own muted styling and doesn't compete with the body.
 */
function wrapBylineParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  const titleIdx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (titleIdx < 0) return markdown;
  // Skip blank lines after the title.
  let bylineStart = titleIdx + 1;
  while (bylineStart < lines.length && !lines[bylineStart].trim()) bylineStart += 1;
  if (bylineStart >= lines.length) return markdown;
  // Byline runs until the next blank line OR the next heading.
  let bylineEnd = bylineStart;
  while (
    bylineEnd < lines.length &&
    lines[bylineEnd].trim() &&
    !/^#/.test(lines[bylineEnd])
  ) {
    bylineEnd += 1;
  }
  if (bylineEnd === bylineStart) return markdown;
  const bylineText = lines.slice(bylineStart, bylineEnd).join(" ");
  // Heuristic: byline lines usually contain commas, asterisks, or `^{` markers.
  if (!/[,*†‡§¶∗^]/.test(bylineText)) return markdown;
  const wrapped = [
    ...lines.slice(0, bylineStart),
    `<p class="reader-byline">${bylineText}</p>`,
    ...lines.slice(bylineEnd),
  ];
  return wrapped.join("\n");
}

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
  onTextSelected?: (text: string, rect: DOMRect, meta?: { hasMath?: boolean }) => void;
  onSelectionClear?: () => void;
}

export function MarkdownReader({
  paperId,
  trial = false,
  onTextSelected,
  onSelectionClear,
}: MarkdownReaderProps) {
  const entry = useStore((s) => s.markdownByPaper[paperId]);
  const setPaperMarkdown = useStore((s) => s.setPaperMarkdown);
  const readerFontScale = useStore((s) => s.uiPrefs.readerFontScale);
  const readerFontFamily = useStore((s) => s.uiPrefs.readerFontFamily);
  const readerLayoutWidth = useStore((s) => s.uiPrefs.readerLayoutWidth);
  const readerLayoutStyle = useStore((s) => s.uiPrefs.readerLayoutStyle);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(!entry);
  const [error, setError] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const { showBanner, dismissBanner } = useReaderHighlights(paperId, containerRef);

  const readerStyle = useMemo(
    () =>
      ({
        "--reader-font-scale": readerFontScale,
        "--reader-font-family": READER_FAMILY_TO_VAR[readerFontFamily],
      }) as CSSProperties,
    [readerFontScale, readerFontFamily],
  );

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
          rawPages.map(async (page, idx) => {
            let prepared = page;
            // Byline cleanup only runs on the first page — the cover.
            if (idx === 0) {
              prepared = collapseAuthorByline(prepared);
              prepared = wrapBylineParagraph(prepared);
            }
            prepared = wrapFigureCaptions(prepared);
            return hydrateMarkdownImages(prepared, paperId, trial);
          }),
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

  const commitSelection = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().trim();
    if (text.length < 2) return;
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    const hasMath = selectionHasMath(text, range);
    onTextSelected?.(text, rect, { hasMath });
  }, [onTextSelected]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const onPointerUp = (e: Event) => {
      if (e.target instanceof Node && root.contains(e.target)) {
        requestAnimationFrame(() => commitSelection());
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key.startsWith("Arrow") || e.key === "a" && (e.metaKey || e.ctrlKey)) {
        requestAnimationFrame(() => commitSelection());
      }
      if (e.key === "Escape") onSelectionClear?.();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.target instanceof Node && root.contains(e.target)) {
        onSelectionClear?.();
      }
    };

    root.addEventListener("mouseup", onPointerUp);
    root.addEventListener("touchend", onPointerUp);
    root.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keyup", onKeyUp);

    return () => {
      root.removeEventListener("mouseup", onPointerUp);
      root.removeEventListener("touchend", onPointerUp);
      root.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [commitSelection, onSelectionClear, pages.length]);

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
    const READER_ALLOWED_TAGS: Record<string, string[]> = {
      figcaption: ["class"],
      sup: [],
      sub: [],
      p: ["class"],
    };
    if (pages.length === 1) {
      return (
        <Streamdown
          plugins={STREAMDOWN_PLUGINS}
          mode="static"
          controls={false}
          parseIncompleteMarkdown={false}
          urlTransform={readerUrlTransform}
          allowedTags={READER_ALLOWED_TAGS}
        >
          {pages[0]}
        </Streamdown>
      );
    }
    return pages.map((body, i) => (
      <section key={i + 1} data-page={i + 1} className="scroll-mt-6">
        <Streamdown
          plugins={STREAMDOWN_PLUGINS}
          mode="static"
          controls={false}
          parseIncompleteMarkdown={false}
          urlTransform={readerUrlTransform}
          allowedTags={READER_ALLOWED_TAGS}
        >
          {body}
        </Streamdown>
      </section>
    ));
  }, [pages]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-[var(--text-sm)] text-muted-foreground">
        <div className="text-foreground/80">
          <OwlSpinner size={48} label="Preparing readable view" />
        </div>
        <p>Preparing readable view…</p>
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
    <div className="relative flex h-full min-h-0 flex-col" style={readerStyle}>
      {showBanner && (
        <div className="reader-chrome border-b border-border/40 bg-muted/[0.08] px-4 py-2 text-[var(--text-xs)] text-muted-foreground">
          Highlights saved with PDF coordinates appear in the original PDF view. Text highlights are shown here when
          we can match the passage.
          <button type="button" onClick={dismissBanner} className="ml-2 underline hover:text-foreground">
            Dismiss
          </button>
        </div>
      )}
      <div className="reader-chrome sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/40 bg-muted/[0.08] px-4 py-2 backdrop-blur-sm">
        {pages.length > 1 ? (
          <span className="text-[var(--text-xs)] tabular-nums text-muted-foreground">
            Page {currentPage} of {pages.length}
          </span>
        ) : (
          <span className="text-[var(--text-xs)] text-muted-foreground/70">Readable view</span>
        )}
        <ReaderFontMenu />
      </div>
      <div
        ref={containerRef}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-y-contain",
          "[scrollbar-gutter:stable]",
        )}
      >
        <div
          className="reader-shell mx-auto w-full max-w-[min(86ch,100%)] px-5 py-8 md:px-10"
          data-layout={readerLayoutWidth}
          data-style={readerLayoutStyle}
        >
          <article className="reader-article mx-auto">{rendered}</article>
        </div>
      </div>
    </div>
  );
}
