"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { api, type PaperFrontMatterData } from "@/lib/api";
import { useStore } from "@/lib/store";
import { READER_FAMILY_TO_VAR } from "@/lib/readerFont";
import { selectionHasMath } from "@/lib/selectionMath";
import { cn } from "@/lib/utils";
import { OwlSpinner } from "@/components/ui/OwlSpinner";
import { useReaderHighlights } from "./useReaderHighlights";
import { ReaderFontMenu } from "./ReaderFontMenu";
import { PaperFrontMatter } from "./PaperFrontMatter";

const math = createMathPlugin({ singleDollarTextMath: true });
const STREAMDOWN_PLUGINS = { math, code };

function readerUrlTransform(url: string): string | null {
  if (!url) return null;
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  if (url.startsWith("mailto:")) return url;
  return null;
}

function rewriteOcrImageReferences(
  markdown: string,
  paperId: string,
  trial: boolean,
): string {
  const ids = Array.from(
    new Set(markdown.match(/(?:p\d+-img-\d+|fig-\d+)\.png/g) ?? []),
  ).sort((a, b) => b.length - a.length);
  if (ids.length === 0) return markdown;

  let out = markdown;
  for (const id of ids) {
    const proxied = api.getOcrImageUrl(paperId, id, trial);
    out = out.split(id).join(proxied);
  }
  return out;
}

/** Drop duplicate title/byline/abstract from body when structured front-matter renders the cover. */
function stripDuplicateFrontMatter(body: string): string {
  const lines = body.split("\n");
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l) && !/^##/.test(l));
  if (h1Idx < 0) return body;

  let i = h1Idx + 1;
  while (i < lines.length && !lines[i].trim()) i += 1;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (/^##\s+/.test(lines[i])) {
      return lines.slice(i).join("\n");
    }
    if (/^(INTRODUCTION|I\.?\s+Introduction)\b/i.test(trimmed)) {
      return lines.slice(i).join("\n");
    }
    if (/^#\s+/.test(lines[i]) && !/^##/.test(lines[i])) {
      return lines.slice(i).join("\n");
    }
    i += 1;
  }

  return lines.slice(h1Idx + 1).join("\n");
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
  const [body, setBody] = useState<string>("");
  const [frontMatter, setFrontMatter] = useState<PaperFrontMatterData | null>(null);
  const [loading, setLoading] = useState(!entry);
  const [error, setError] = useState("");

  const { showBanner, dismissBanner } = useReaderHighlights(paperId, containerRef);
  const activeSelection = useStore(
    (s) => s.selectionResultByPaper[paperId] ?? null,
  );

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

        let joined = rawPages.join("\n\n");
        joined = rewriteOcrImageReferences(joined, paperId, trial);

        const fm = payload.front_matter ?? null;
        if (fm?.title) {
          joined = stripDuplicateFrontMatter(joined);
        }

        if (!cancelled) {
          setBody(joined);
          setFrontMatter(fm?.title ? fm : null);
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
    if (!root || !body) return;

    const apply = () => {
      root.querySelectorAll<HTMLParagraphElement>("p").forEach((p) => {
        if (p.classList.contains("reader-figure-caption")) return;
        const text = (p.textContent || "").trim();
        if (/^(Fig\.?|Figure)\s+\d+[.:]/i.test(text)) {
          p.classList.add("reader-figure-caption");
        }
      });

      const action = activeSelection?.action;
      const needle = (activeSelection?.selected_text || "").trim();
      const wantWrap =
        (action === "explain" || action === "derive") && needle.length >= 8;

      const existing = root.querySelector<HTMLElement>(".reader-active-analysis");
      const existingMatches =
        existing &&
        wantWrap &&
        existing.classList.contains(`reader-active-analysis--${action}`) &&
        (existing.textContent || "").includes(needle.slice(0, 32));
      if (existingMatches) return;

      root.querySelectorAll(".reader-active-analysis").forEach((el) => {
        const parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      });

      if (!wantWrap) return;

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || "";
        const idx = text.indexOf(needle);
        if (idx < 0) continue;
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + needle.length);
          const mark = document.createElement("mark");
          mark.className = `reader-active-analysis reader-active-analysis--${action}`;
          range.surroundContents(mark);
        } catch {
          /* range spans multiple nodes */
        }
        break;
      }
    };

    apply();
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame(apply)
        : 0;
    const t = window.setTimeout(apply, 800);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [body, activeSelection]);

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
  }, [commitSelection, onSelectionClear, body]);

  const rendered = useMemo(() => {
    if (!body) return null;
    const READER_ALLOWED_TAGS: Record<string, string[]> = {
      figcaption: ["class"],
      sup: [],
      sub: [],
      p: ["class"],
      mark: ["class"],
    };
    return (
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
    );
  }, [body]);

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

  if (error || !body) {
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
      <div className="reader-chrome sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-border/40 bg-background px-4 py-1.5">
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
          className="reader-shell w-full px-5 py-8 md:px-10"
          data-layout={readerLayoutWidth}
          data-style={readerLayoutStyle}
        >
          <article className="reader-article mx-auto">
            {frontMatter ? <PaperFrontMatter frontMatter={frontMatter} /> : null}
            {rendered}
          </article>
        </div>
      </div>
    </div>
  );
}
