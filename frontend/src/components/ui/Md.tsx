"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { preprocessLatex } from "@/lib/latex";

interface MdProps {
  children: string;
  className?: string;
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

export const Md = memo(function Md({ children, className }: MdProps) {
  // Per audit §6.2: preprocessing was running on every parent
  // re-render (notably every streamed summary chunk). Memoizing on
  // `children` avoids thousands of repeated regex passes.
  const processed = useMemo(() => preprocessLatex(children), [children]);

  return (
    <div className={className ?? "analysis-content"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
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
