/**
 * Extract tables and fenced code blocks from Mistral OCR markdown.
 */

import type { ParsedPaper } from "@/lib/api";

export type OcrTable = {
  id: string;
  label: string;
  markdown: string;
  pageHint?: number;
};

export type OcrCodeBlock = {
  id: string;
  language: string;
  code: string;
  /** Surrounding caption / section line when present. */
  context: string;
};

const TABLE_LABEL_RE =
  /(?:Table|TABLE)\s+(?:S[\d.]+\s*)?[\dIVXLC]+(?:[.:]|(?=\s|$))/i;
const PIPE_ROW_RE = /^\s*\|.*\|\s*$/;
const PIPE_SEP_RE = /^\s*\|?\s*:?-{2,}/;
const FENCE_RE = /^```(\w*)?\s*$/;

function paperMarkdown(paper: ParsedPaper | null | undefined): string {
  if (!paper) return "";
  return (paper.markdown || "").trim() || (paper.raw_text || "").trim();
}

/** Attach OCR markdown loaded outside the ParsedPaper payload (excluded from getPaper). */
export function paperWithOcrMarkdown(
  paper: ParsedPaper | null | undefined,
  markdown: string,
): ParsedPaper | null | undefined {
  if (!paper || !markdown.trim()) return paper;
  return { ...paper, markdown: markdown.trim() };
}

export function tablesFromPaper(paper: ParsedPaper | null | undefined): OcrTable[] {
  const md = paperMarkdown(paper);
  if (!md) return [];

  const lines = md.split("\n");
  const raw: Array<{ label: string; markdown: string }> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const cap = line.match(TABLE_LABEL_RE);
    if (cap) {
      const caption = line.trim();
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length && PIPE_ROW_RE.test(lines[j])) {
        const tableLines: string[] = [caption];
        let k = j;
        while (k < lines.length && PIPE_ROW_RE.test(lines[k])) {
          tableLines.push(lines[k]);
          k += 1;
        }
        raw.push({ label: cap[0].trim(), markdown: tableLines.join("\n").trim() });
        i = k;
        continue;
      }
      if (caption.length > 8) {
        raw.push({ label: cap[0].trim(), markdown: caption });
      }
      i += 1;
      continue;
    }

    if (PIPE_ROW_RE.test(line)) {
      const tableLines = [line];
      i += 1;
      if (i < lines.length && PIPE_SEP_RE.test(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      while (i < lines.length && PIPE_ROW_RE.test(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      raw.push({ label: "Table", markdown: tableLines.join("\n").trim() });
      continue;
    }

    i += 1;
  }

  const seen = new Set<string>();
  const out: OcrTable[] = [];
  raw.forEach((item, idx) => {
    const key = item.markdown.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: `table-${idx}`,
      label: item.label,
      markdown: item.markdown,
    });
  });
  return out;
}

export function codeBlocksFromPaper(paper: ParsedPaper | null | undefined): OcrCodeBlock[] {
  const md = paperMarkdown(paper);
  if (!md) return [];

  const lines = md.split("\n");
  const blocks: OcrCodeBlock[] = [];
  let i = 0;
  let blockIdx = 0;

  while (i < lines.length) {
    const open = lines[i].match(FENCE_RE);
    if (!open) {
      i += 1;
      continue;
    }
    const language = (open[1] || "").trim() || "text";
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !FENCE_RE.test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    if (i < lines.length) i += 1;
    const code = body.join("\n").trim();
    if (!code || code.length < 4) continue;

    let context = "";
    for (let j = i - body.length - 2; j >= 0 && j >= i - body.length - 6; j--) {
      const prev = lines[j]?.trim();
      if (prev && !prev.startsWith("```") && !PIPE_ROW_RE.test(prev)) {
        context = prev;
        break;
      }
    }

    blocks.push({
      id: `code-${blockIdx}`,
      language,
      code,
      context,
    });
    blockIdx += 1;
  }

  return blocks;
}

export function hasOcrArtifacts(paper: ParsedPaper | null | undefined): {
  tables: boolean;
  code: boolean;
} {
  return {
    tables: tablesFromPaper(paper).length > 0,
    code: codeBlocksFromPaper(paper).length > 0,
  };
}
