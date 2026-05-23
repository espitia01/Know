"use client";

import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from "react";
import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { READER_FAMILY_TO_VAR } from "@/lib/readerFont";
import { selectionHasMath } from "@/lib/selectionMath";
import { cn } from "@/lib/utils";
import { OwlSpinner } from "@/components/ui/OwlSpinner";
import { useReaderHighlights } from "./useReaderHighlights";
import { ReaderFontMenu } from "./ReaderFontMenu";

const math = createMathPlugin({ singleDollarTextMath: true });
const STREAMDOWN_PLUGINS = { math, code };

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
  // Only operate on the first ~24 non-blank lines after a title — past
  // that we're definitely in the abstract / body. Bumped from 12 to
  // accommodate Sci. Adv.–style pages with long author lists.
  let bylineBudget = 24;
  // A "marker" is any short line that's purely digits/punctuation
  // (commas, asterisks, daggers, ∗, etc.). Mistral emits affiliation
  // tags as separate paragraphs: "1\n,\n2\n1,2" — each piece a marker.
  const isMarkerLine = (s: string) =>
    /^[\s\d,.;:*†‡§¶∗∥]+$/.test(s) && s.length <= 8;
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
    // Gather any following marker-only lines as a cluster, allowing
    // blank-line separators inside the cluster.
    const cluster: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      if (!lines[j].trim()) {
        // Lookahead: is the next non-blank line still a marker?
        let k = j + 1;
        while (k < lines.length && !lines[k].trim()) k += 1;
        if (k < lines.length && isMarkerLine(lines[k].trim())) {
          j = k;
          continue;
        }
        break;
      }
      if (!isMarkerLine(lines[j].trim())) break;
      cluster.push(lines[j].trim());
      j += 1;
    }
    // Cluster must contain at least one digit somewhere to be
    // considered an affiliation marker (not just stray punctuation).
    const hasDigit = cluster.some((c) => /\d/.test(c));
    if (cluster.length >= 2 && hasDigit) {
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
 * When the compositor produced fig-N.png composites for this paper,
 * drop the lingering panel-level `p\d+-img-\d+\.png` refs from the
 * markdown — they're already represented by the composite and showing
 * both gives the random-looking "extra figure" placeholders the user
 * sees between captions and prose.
 */
function dropPanelRefsWhenCompositesExist(markdown: string): string {
  const hasComposite = /(?:^|[^A-Za-z0-9])fig-\d+\.png/.test(markdown);
  if (!hasComposite) return markdown;
  // Remove the whole markdown image line (and any adjacent blank line)
  // when the src is a bare panel id.
  return markdown
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // Match `![alt](p0-img-0.png)` or bare `p0-img-0.png` lines.
      if (/^!\[[^\]]*\]\(p\d+-img-\d+\.png\)\s*$/.test(t)) return false;
      if (/^p\d+-img-\d+\.png\s*$/.test(t)) return false;
      return true;
    })
    .join("\n");
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

/**
 * Detect and strip the repeating page headers/footers that journals
 * insert on every page (e.g. "VOLUME 90 NUMBER 7 PHYSICAL REVIEW
 * LETTERS"). Any short line that appears in ≥2 pages near the top or
 * bottom is treated as chrome.
 */
function stripRunningHeadersFooters(pages: string[]): string[] {
  if (pages.length < 2) return pages;
  const SAMPLE = 4; // first/last N non-blank lines per page
  const counts = new Map<string, number>();
  const sample: string[][] = pages.map((p) => {
    const lines = p.split("\n");
    const nonBlank = lines.filter((l) => l.trim());
    const head = nonBlank.slice(0, SAMPLE);
    const tail = nonBlank.slice(-SAMPLE);
    return [...new Set([...head, ...tail])];
  });
  for (const set of sample) {
    for (const line of set) {
      // Only consider short lines (<= 140 chars) that aren't headings or images.
      const t = line.trim();
      if (!t || t.length > 140) continue;
      if (t.startsWith("#") || t.startsWith("!") || t.startsWith("|")) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  const drop = new Set(
    [...counts.entries()]
      .filter(([, n]) => n >= threshold)
      .map(([k]) => k),
  );
  if (drop.size === 0) return pages;
  return pages.map((p) =>
    p
      .split("\n")
      .filter((l) => !drop.has(l.trim()))
      .join("\n"),
  );
}

/**
 * Merge consecutive short paragraphs whose content is a single
 * `$x$` inline math (1-3 chars) — these are OCR-fallback artifacts
 * where stacked superscripts or column breaks fragment a single
 * token across multiple lines.
 */
function collapseFragmentedMathParagraphs(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!/^\$[^$]{1,3}\$$/.test(line.trim())) {
      out.push(line);
      i += 1;
      continue;
    }
    const collected: string[] = [line.trim()];
    let j = i + 1;
    while (
      j < lines.length &&
      (lines[j].trim() === "" || /^\$[^$]{1,3}\$$/.test(lines[j].trim()))
    ) {
      if (lines[j].trim()) collected.push(lines[j].trim());
      j += 1;
    }
    if (collected.length > 1) {
      out.push(collected.join(" "));
    } else {
      out.push(line);
    }
    i = j;
  }
  return out.join("\n");
}

/**
 * Drop Mistral OCR's ASCII-fallback duplication. Mistral often emits
 * each glyph of a math token as its own paragraph (separated by blank
 * lines) BEFORE the full text run or display math block — producing
 * vertical stacks like:
 *
 *     ν
 *     c
 *     (
 *     r̂
 *     ...
 *     $$\nu_c(\hat r, \hat r') = 1/|\hat r - \hat r'|.$$
 *
 * These stacks are almost never legitimate prose: real paragraphs are
 * never 1-3 characters tall for 3+ rows in a row. We collapse any run
 * of ≥3 short lines (≤4 chars each, allowing blank separators) into
 * nothing if the following content is math or a continuation; otherwise
 * we keep the cluster.
 */
function stripOcrAsciiFallback(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  const isShortGlyph = (s: string) => {
    const t = s.trim();
    if (!t || t.length > 5) return false;
    // Don't kill markdown chrome that happens to be short.
    if (/^[#>|`]/.test(t)) return false;
    if (/^\d+\.$/.test(t)) return false; // "1." ordered list marker
    if (/^!\[/.test(t)) return false; // image markdown
    if (/^---+$/.test(t)) return false; // hr
    if (/^\* /.test(t)) return false; // list item
    // Otherwise: any line ≤5 characters is candidate OCR fallback.
    // We rely on the cluster threshold (≥3 in a row) to avoid false
    // positives — real prose doesn't string 3+ tiny paragraphs.
    return true;
  };

  const dropClusterAndJoin = (postJ: number) => {
    // Eat trailing blanks from out (the paragraph break BEFORE the
    // cluster) and the blank lines AFTER the cluster too — this
    // fuses the surrounding paragraphs into one continuous paragraph
    // instead of leaving them as two separated by an empty gap.
    while (out.length > 0 && !out[out.length - 1].trim()) out.pop();
    let k = postJ;
    while (k < lines.length && !lines[k].trim()) k += 1;
    return k;
  };

  while (i < lines.length) {
    const cluster: number[] = [];
    let j = i;
    while (j < lines.length) {
      if (!lines[j].trim()) {
        if (cluster.length === 0) break;
        // Lookahead: is the next non-blank line still a short glyph?
        let k = j + 1;
        while (k < lines.length && !lines[k].trim()) k += 1;
        if (k < lines.length && isShortGlyph(lines[k])) {
          j = k;
          continue;
        }
        break;
      }
      if (!isShortGlyph(lines[j])) break;
      cluster.push(j);
      j += 1;
    }
    if (cluster.length >= 3) {
      // Run of ≥3 short lines = OCR fallback. Drop unconditionally.
      i = dropClusterAndJoin(j);
      continue;
    }
    if (cluster.length === 2) {
      // Two-line case: only drop when followed by a longer run that
      // begins with the concatenated letters of the cluster.
      let k = j;
      while (k < lines.length && !lines[k].trim()) k += 1;
      const followUp = k < lines.length ? lines[k].trim() : "";
      const concat = cluster
        .map((idx) => lines[idx].trim().replace(/\$/g, ""))
        .join("");
      const concatLetters = concat.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      const followLetters = followUp.slice(0, 16).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      if (concatLetters.length >= 2 && followLetters.startsWith(concatLetters)) {
        i = dropClusterAndJoin(j);
        continue;
      }
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n");
}

/**
 * Strip the per-page running footer Mistral pastes between pages:
 *
 *     076401-1 0031-9007/03/90(7)/076401(4)$20.00 © 2003 The American Physical Society 076401-1
 *
 * Detect lines that match the journal-style "<id> ... © <year> <publisher> <id>" shape, or
 * standalone page-id pairs like "076401-1 076401-1". These never carry
 * useful content for the reader.
 */
function stripPageNumberFooters(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      // "076401-1 076401-1" or similar duplicated page id pairs.
      if (/^[\d\-]{3,}\s+[\d\-]{3,}$/.test(t) && /\d-\d/.test(t)) return false;
      // Full journal copyright lines.
      if (
        /^\S+\s+\d{4}[\-/]\d{4}\/\d.*©\s+\d{4}.*Physical Society/i.test(t) ||
        /©\s*\d{4}.+Physical Society/i.test(t)
      ) {
        return false;
      }
      return true;
    })
    .join("\n");
}

/**
 * Rewrite every OCR image id in the markdown to its same-origin proxy
 * URL. Previous approaches (custom <img> component, async fetch +
 * blob:URL hydration, urlTransform whitelist) all had a single point
 * of failure: if anything went wrong in JS land — Bearer token stale,
 * Streamdown bypassing components.img, proxy hot-reloading — the raw
 * `p0-img-0.png` id was left in the markdown and the browser tried to
 * load it as a relative URL, showing the broken-image alt text.
 *
 * Rewriting to `/api/papers/{paperId}/ocr-image/{imageId}` lets the
 * browser load the image with a plain <img> request, which sends the
 * Clerk session cookie same-origin. No Bearer header needed, no
 * fetch lifecycle, no async race. If the user is signed in, the
 * image loads; if not, the proxy returns 401 and we still show a
 * better fallback than the raw id.
 */
function rewriteOcrImageReferences(
  markdown: string,
  paperId: string,
  trial: boolean,
): string {
  // Process longer ids first so a substring (e.g. `p1-img-1.png`) of a
  // longer one (e.g. `p1-img-10.png`) doesn't get rewritten by mistake.
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
  const [loading, setLoading] = useState(!entry);
  const [error, setError] = useState("");

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

        // Strip running headers/footers that appear on ≥2 pages so the
        // body reads like a single document instead of a stack of
        // identical journal mastheads.
        const cleanedPages = stripRunningHeadersFooters(rawPages);

        // Join all pages into one continuous document. The visual page
        // breaks were a PDF artifact, not a structural one — sections
        // flow across them.
        let joined = cleanedPages.join("\n\n");
        joined = stripPageNumberFooters(joined);
        // Run dedup TWICE: the second pass catches stacks revealed
        // once the first pass removes adjacent display-math blocks.
        joined = stripOcrAsciiFallback(joined);
        joined = stripOcrAsciiFallback(joined);
        joined = collapseAuthorByline(joined);
        joined = wrapBylineParagraph(joined);
        joined = dropPanelRefsWhenCompositesExist(joined);
        joined = wrapFigureCaptions(joined);
        joined = collapseFragmentedMathParagraphs(joined);
        joined = rewriteOcrImageReferences(joined, paperId, trial);

        if (!cancelled) {
          setBody(joined);
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
      <div className="reader-chrome sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-border/35 bg-background/85 px-4 py-1.5 backdrop-blur-md">
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
          <article className="reader-article mx-auto">{rendered}</article>
        </div>
      </div>
    </div>
  );
}
