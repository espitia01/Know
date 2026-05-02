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
        placeholder="Markdown · $…$ / $$…$$ = inline math · $$$$…$$$$ = display"
        className="note-md-textarea block w-full resize-y border-0 bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        style={{ minHeight }}
      />
      <div className="border-t border-border/60 bg-muted/25 px-3 py-2">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/85">
            Preview
          </p>
          <p className="text-[10px] leading-snug text-muted-foreground/75">
            <span className="font-medium text-muted-foreground/90">Math:</span>{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px]">$$…$$</code>{" "}
            inline ·{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px]">$$$$…$$$$</code>{" "}
            display · <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px]">$…$</code>{" "}
            inline
          </p>
        </div>
        <div className="max-h-[min(55vh,480px)] overflow-y-auto rounded-md bg-card/50 px-2.5 py-2">
          {(value || "").trim() ? (
            <Md className="analysis-content note-markdown-preview text-[var(--text-md)]" latexMode="note">
              {value}
            </Md>
          ) : (
            <p className="text-[var(--text-sm)] italic text-muted-foreground/75">Nothing to preview yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
