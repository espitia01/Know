"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "@uiw/react-md-editor/markdown-editor.css";

function useDocsColorMode(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">("light");
  useEffect(() => {
    const sync = () =>
      setMode(document.documentElement.classList.contains("dark") ? "dark" : "light");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return mode;
}

const MDEditor = dynamic(
  () => import("@uiw/react-md-editor").then((m) => m.default),
  { ssr: false },
);

const katexOpts = { throwOnError: false, strict: false as const };

interface NoteMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  minHeight?: number;
  /** For focus on mount */
  autoFocus?: boolean;
}

export function NoteMarkdownEditor({
  value,
  onChange,
  minHeight = 200,
  autoFocus,
}: NoteMarkdownEditorProps) {
  const colorMode = useDocsColorMode();

  // remark-math / rehype-katex tuple types diverge from @uiw/react-md-editor's Pluggable[] typings.
  const previewOptions = useMemo(
    () =>
      ({
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [[rehypeKatex, katexOpts]],
      }) as const,
    [],
  );

  return (
    <div className="rounded-lg border border-border/70 overflow-hidden note-md-editor" data-color-mode={colorMode}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? "")}
        preview="live"
        height={minHeight}
        visibleDragbar={false}
        textareaProps={{
          placeholder: "Markdown with LaTeX — e.g. inline $x^2$ or display $$\\sum_i x_i$$",
          style: { minHeight },
          ...(autoFocus ? { autoFocus: true } : {}),
        }}
        previewOptions={previewOptions as never}
      />
    </div>
  );
}
