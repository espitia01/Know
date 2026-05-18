"use client";

/**
 * @deprecated Stage 4 migration. Every panel that renders LLM output now
 * renders via `<StreamingMarkdown>` (Streamdown + KaTeX). `Md` and the
 * 956-line `preprocessLatex` it depends on are kept around only for the
 * Notes path, which still authors via the `note` LaTeX mode (`$$$$` for
 * display math) and stores prepared markdown in the database — that
 * persisted shape is incompatible with Streamdown's `$...$` rules. Do
 * not import `Md` in new code; use `StreamingMarkdown` instead.
 */

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { preprocessLatex } from "@/lib/latex";
import { rehypeKatexEquationCards } from "@/lib/rehypeKatexEquationCard";

interface MdProps {
  children: string;
  className?: string;
  /**
   * `note` remaps `$$$$`→display and `$$`→inline, and skips aggressive
   * display promotion heuristics used for LLM analysis text.
   */
  latexMode?: "analysis" | "note";
}

// Allow only schemes safe to render in-app. In particular, block
// `javascript:`, `data:`, `vbscript:`, `file:` and any whitespace/unicode
// tricks that react-markdown's default permissive allow-list lets through.
// LLM-generated content is untrusted input: treat it accordingly.
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel", "#"]);

function sanitizeHref(raw: string | undefined): string {
  if (!raw) return "#";
  const trimmed = raw.trim();
  if (!trimmed) return "#";
  // Protocol-relative (`//foo.com`) and same-document fragments (`#section`)
  // are safe.
  if (trimmed.startsWith("//") || trimmed.startsWith("#")) return trimmed;
  // Relative paths (./, ../, /foo, foo.html) don't contain a scheme.
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(trimmed);
  if (!schemeMatch) return trimmed;
  const scheme = schemeMatch[1].toLowerCase();
  if (SAFE_SCHEMES.has(scheme)) return trimmed;
  return "#";
}

export const Md = memo(function Md({ children, className, latexMode = "analysis" }: MdProps) {
  // Per audit §6.2: preprocessing was running on every parent
  // re-render (notably every streamed summary chunk). Memoizing on
  // `children` avoids thousands of repeated regex passes.
  const processed = useMemo(
    () => preprocessLatex(children, { noteMode: latexMode === "note" }),
    [children, latexMode],
  );

  const katexOptions = useMemo(
    () => ({
      throwOnError: false,
      // Lenient parsing: partial/streaming TeX and uncommon macros should
      // degrade gracefully instead of blowing up the whole markdown block.
      strict: false as const,
    }),
    [],
  );

  return (
    <div className={className ?? "analysis-content"}>
      <ReactMarkdown
        // Parse math before GFM so underscores inside $…$ are not eaten as emphasis.
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[[rehypeKatex, katexOptions], rehypeKatexEquationCards]}
        components={{
          a: ({ href, children: linkChildren }) => (
            <a
              href={sanitizeHref(href)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {linkChildren}
            </a>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});
