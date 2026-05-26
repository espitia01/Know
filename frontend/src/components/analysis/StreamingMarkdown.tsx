"use client";

/**
 * Single shared markdown renderer for migrated analysis paths.
 *
 * Wraps `streamdown`'s `Streamdown` with the project's visual language
 * (typography, math overflow, code spacing) and our preferred plugin
 * config:
 *   - `@streamdown/math` with `singleDollarTextMath: true` so $...$ is
 *     inline math (not the default `\(...\)`).
 *   - `@streamdown/code` for Shiki syntax highlighting in fenced
 *     blocks.
 *
 * The math plugin handles streaming-safe rendering — partial `$$`
 * blocks render as plain text until the closing delimiter arrives,
 * which is exactly how we kill LaTeX symptom (c).
 *
 * KaTeX CSS is imported once at module scope so every consumer
 * inherits it without each panel having to remember.
 */

import "katex/dist/katex.min.css";

import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { sanitizeStreamdownMath } from "@/lib/streamdownMath";

const math = createMathPlugin({ singleDollarTextMath: true });

const STREAMDOWN_PLUGINS = { math, code };

/**
 * Repair common LLM-emitted markup mistakes before Streamdown sees the
 * source. See `streamdownMath.ts` for the full repair list.
 */
type StreamingMarkdownProps = {
  /** Raw markdown. May contain `$...$` / `$$...$$` math. */
  children: string | null | undefined;
  /** True while the source is still being produced. Drives the caret + animation. */
  streaming?: boolean;
  /**
   * Visual size variant. Defaults to body text. Use `tight` for titles /
   * pill-style cells where the prose paragraph margin would be wrong:
   * the wrapper drops the `prose` typography defaults and renders the
   * markdown without per-paragraph spacing.
   */
  size?: "sm" | "md" | "tight";
  className?: string;
  /** Enable Streamdown copy controls on fenced code blocks. */
  copyableCode?: boolean;
};

const SIZE_CLASS: Record<NonNullable<StreamingMarkdownProps["size"]>, string> = {
  sm: "prose prose-sm max-w-none leading-relaxed dark:prose-invert",
  md: "prose prose-sm md:prose-base max-w-none leading-relaxed dark:prose-invert",
  // `tight`: math-aware inline rendering for titles. We keep the
  // analysis-content hook so KaTeX-rendered math inherits the
  // panel's typography, but strip the prose paragraph margins so a
  // single-line term doesn't gain extra vertical space.
  tight: "[&_p]:m-0 [&_p]:inline [&_p]:leading-snug",
};

export const StreamingMarkdown = memo(function StreamingMarkdown({
  children,
  streaming = false,
  size = "sm",
  className,
  copyableCode = false,
}: StreamingMarkdownProps) {
  const raw = typeof children === "string" ? children : "";
  const text = useMemo(() => sanitizeStreamdownMath(raw), [raw]);
  return (
    <div className={[SIZE_CLASS[size], "analysis-content", className].filter(Boolean).join(" ")}>
      <Streamdown
        plugins={STREAMDOWN_PLUGINS}
        // Streaming mode parses incomplete markdown so half-typed `$$`,
        // unclosed code fences, and partial tables render gracefully.
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        // Disable copy/download chrome by default — analysis panels
        // already render in cards with their own affordances.
        controls={copyableCode}
      >
        {text}
      </Streamdown>
    </div>
  );
});
