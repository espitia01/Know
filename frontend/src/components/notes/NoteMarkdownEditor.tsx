"use client";

import { Md } from "@/components/ui/Md";

interface NoteMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  minHeight?: number;
  /** For focus on mount */
  autoFocus?: boolean;
}

/**
 * Simple Markdown + LaTeX notes compose surface: monospace editor always
 * visible with a rendered preview underneath. Avoids fullscreen / preview-only
 * modes from third-party editors that left users stuck on an empty pane.
 */
export function NoteMarkdownEditor({
  value,
  onChange,
  minHeight = 200,
  autoFocus,
}: NoteMarkdownEditorProps) {
  return (
    <div className="note-md-stack space-y-2 rounded-lg border border-border/70 overflow-hidden bg-card/20">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck
        {...(autoFocus ? { autoFocus: true } : {})}
        placeholder="Markdown with LaTeX — e.g. inline $x^2$ or display $$\sum_i x_i$$"
        className="note-md-textarea block w-full resize-y border-0 bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        style={{ minHeight }}
      />
      <div className="border-t border-border/60 bg-muted/25 px-3 py-2">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/85">
          Preview
        </p>
        <div className="max-h-[min(55vh,480px)] overflow-y-auto rounded-md bg-card/50 px-2.5 py-2">
          {(value || "").trim() ? (
            <Md className="analysis-content note-markdown-preview text-[var(--text-md)]">{value}</Md>
          ) : (
            <p className="text-[var(--text-sm)] italic text-muted-foreground/75">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
