/**
 * Extract tables and code / algorithm blocks from Mistral OCR markdown.
 */

import type { ParsedPaper } from "@/lib/api";

export type OcrTable = {
  id: string;
  /** Short label, e.g. "Table 1". */
  label: string;
  /** Optional caption line (not the pipe grid). */
  caption?: string;
  /** Full block for LLM prompts (caption + pipe rows). */
  markdown: string;
};

export type OcrCodeBlock = {
  id: string;
  language: string;
  code: string;
  /** Heading / caption (e.g. Algorithm 1 …). */
  context: string;
  title?: string;
};

const TABLE_LABEL_RE =
  /(?:Table|TABLE)\s+(?:S[\d.]+\s*)?([\dIVXLC]+)(?:[.:]|(?=\s|$))/i;
const PIPE_ROW_RE = /^\s*\|.*\|\s*$/;
const PIPE_SEP_RE = /^\s*\|?\s*:?-{2,}/;
const FENCE_RE = /^```(\w*)?\s*$/;
const ALGORITHM_HEADER_RE = /^Algorithm\s+(\d+)\b/i;
const PAGE_FOOTER_RE = /^\d{1,3}$/;

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

export function tableNumberFromLabel(label: string): string | null {
  const m = label.match(TABLE_LABEL_RE);
  return m ? m[1] : null;
}

/** Pipe grid only — for clean table preview in the UI. */
export function tableBodyMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .filter((l) => PIPE_ROW_RE.test(l) || PIPE_SEP_RE.test(l))
    .join("\n")
    .trim();
}

export function tableCaptionFromMarkdown(markdown: string, label: string): string | undefined {
  const prose = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !PIPE_ROW_RE.test(l) && !PIPE_SEP_RE.test(l));
  const first = prose[0];
  if (!first || first === label) return undefined;
  if (first.length > 160) return undefined;
  if (!TABLE_LABEL_RE.test(first) && first.length > 8) return first;
  const rest = prose.slice(1).join(" ").trim();
  if (rest.length > 0 && rest.length <= 120) return rest;
  return undefined;
}

function formatTableLabel(num: string | null, captionLine?: string): string {
  const base = num ? `Table ${num}` : "Table";
  if (!captionLine) return base;
  const stripped = captionLine.replace(TABLE_LABEL_RE, "").replace(/^[:.\s]+/, "").trim();
  if (!stripped || stripped.length > 72) return base;
  return `${base} — ${stripped}`;
}

function isPseudocodeLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (PAGE_FOOTER_RE.test(t)) return false;
  if (ALGORITHM_HEADER_RE.test(t)) return false;
  if (TABLE_LABEL_RE.test(t) && !/\b(def|for|while|return)\b/i.test(t)) return false;
  if (/^#{1,6}\s/.test(t)) return false;
  if (/^```/.test(t)) return false;
  if (/^\s*#/.test(line)) return true;
  if (/\b(def|for|while|return|class|import|from|elif|else:)\b/i.test(t)) return true;
  if (/^[A-Za-z_][\w.]*\s*\(/.test(t)) return true;
  if (/[=<>]=?/.test(t) && /[();]/.test(t)) return true;
  if (/^\s{2,}\S/.test(line) && !/\b(the|and|we|our|this)\b/i.test(t)) return true;
  if (
    t.length < 120 &&
    /^[\w\s.,():+\-*/\[\]<>=%|&|^~'"`\\…]+$/.test(t) &&
    !/\b(compare|results|section|figure)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

type RawPipeTable = {
  label: string;
  num: string | null;
  captionLine?: string;
  pipeLines: string[];
};

function findTableLabelAbove(lines: string[], pipeStart: number): { label: string; num: string | null; captionLine?: string } {
  let captionLine: string | undefined;
  for (let k = pipeStart - 1; k >= 0 && k >= pipeStart - 24; k--) {
    const t = lines[k]?.trim();
    if (!t) continue;
    const m = t.match(TABLE_LABEL_RE);
    if (m) {
      const num = m[1];
      if (t.length <= 160) captionLine = t;
      return { label: formatTableLabel(num, captionLine), num, captionLine };
    }
    if (!captionLine && t.length <= 120 && !PIPE_ROW_RE.test(t) && !/^!\[/.test(t)) {
      captionLine = t;
    }
  }
  return { label: "Table", num: null, captionLine };
}

function collectPipeTables(lines: string[]): RawPipeTable[] {
  const raw: RawPipeTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!PIPE_ROW_RE.test(lines[i])) {
      i += 1;
      continue;
    }
    const pipeStart = i;
    const pipeLines: string[] = [lines[i]];
    i += 1;
    if (i < lines.length && PIPE_SEP_RE.test(lines[i])) {
      pipeLines.push(lines[i]);
      i += 1;
    }
    while (i < lines.length && PIPE_ROW_RE.test(lines[i])) {
      pipeLines.push(lines[i]);
      i += 1;
    }
    if (pipeLines.length < 2) continue;
    const { label, num, captionLine } = findTableLabelAbove(lines, pipeStart);
    raw.push({ label, num, captionLine, pipeLines });
  }
  return raw;
}

function mergeTables(raw: RawPipeTable[]): OcrTable[] {
  const byKey = new Map<string, RawPipeTable>();

  for (const item of raw) {
    const body = item.pipeLines.join("\n");
    const bodyKey = body.slice(0, 120);
    const numKey = item.num ? `n:${item.num}` : `b:${bodyKey}`;
    const existing = byKey.get(numKey);
    if (!existing) {
      byKey.set(numKey, item);
      continue;
    }
    const existingBody = existing.pipeLines.join("\n");
    if (body.length > existingBody.length) {
      byKey.set(numKey, item);
    } else if (body.length === existingBody.length && item.label.length > existing.label.length) {
      byKey.set(numKey, item);
    }
  }

  const out: OcrTable[] = [];
  const seenBody = new Set<string>();

  for (const item of byKey.values()) {
    const body = item.pipeLines.join("\n").trim();
    if (seenBody.has(body)) continue;
    seenBody.add(body);

    const num = item.num;
    const id = num ? `table-${num}` : `table-${out.length}`;
    const caption =
      item.captionLine && item.captionLine.length <= 160
        ? tableCaptionFromMarkdown(`${item.captionLine}\n${body}`, item.label)
        : undefined;
    const markdown = item.captionLine && item.captionLine.length <= 160
      ? `${item.captionLine}\n\n${body}`
      : body;

    out.push({
      id,
      label: item.label,
      caption,
      markdown,
    });
  }

  return out.sort((a, b) => {
    const na = tableNumberFromLabel(a.label);
    const nb = tableNumberFromLabel(b.label);
    if (na && nb) {
      const ai = parseInt(na, 10);
      const bi = parseInt(nb, 10);
      if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
    }
    return a.label.localeCompare(b.label);
  });
}

export function tablesFromPaper(paper: ParsedPaper | null | undefined): OcrTable[] {
  const md = paperMarkdown(paper);
  if (!md) return [];
  return mergeTables(collectPipeTables(md.split("\n")));
}

function collectFencedBlocks(lines: string[]): OcrCodeBlock[] {
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
      title: context || undefined,
    });
    blockIdx += 1;
  }

  return blocks;
}

function collectAlgorithmBlocks(lines: string[]): OcrCodeBlock[] {
  const blocks: OcrCodeBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerMatch = lines[i].trim().match(ALGORITHM_HEADER_RE);
    if (!headerMatch) {
      i += 1;
      continue;
    }
    const num = headerMatch[1];
    const header = lines[i].trim();
    const body: string[] = [];
    i += 1;
    let nonCodeStreak = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (ALGORITHM_HEADER_RE.test(trimmed)) break;
      if (FENCE_RE.test(trimmed)) break;
      if (TABLE_LABEL_RE.test(trimmed) && !isPseudocodeLine(line)) break;
      if (PAGE_FOOTER_RE.test(trimmed)) {
        i += 1;
        break;
      }

      if (isPseudocodeLine(line)) {
        body.push(line);
        nonCodeStreak = trimmed ? 0 : nonCodeStreak;
      } else if (!trimmed) {
        body.push(line);
      } else {
        nonCodeStreak += 1;
        if (nonCodeStreak >= 2) break;
      }
      i += 1;
    }

    const code = body.join("\n").trim();
    if (code.length < 40) continue;
    if (!/\b(def|for|while|return)\b/i.test(code) && !/^\s*#/m.test(code)) continue;

    blocks.push({
      id: `algorithm-${num}`,
      language: "pseudocode",
      code,
      context: header,
      title: header,
    });
  }

  return blocks;
}

export function codeBlocksFromPaper(paper: ParsedPaper | null | undefined): OcrCodeBlock[] {
  const md = paperMarkdown(paper);
  if (!md) return [];

  const lines = md.split("\n");
  const fenced = collectFencedBlocks(lines);
  const algorithms = collectAlgorithmBlocks(lines);

  const seen = new Set<string>();
  const out: OcrCodeBlock[] = [];

  for (const block of [...algorithms, ...fenced]) {
    const key = block.code.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }

  return out.sort((a, b) => {
    const aAlg = a.id.startsWith("algorithm-");
    const bAlg = b.id.startsWith("algorithm-");
    if (aAlg && bAlg) {
      return parseInt(a.id.replace("algorithm-", ""), 10) - parseInt(b.id.replace("algorithm-", ""), 10);
    }
    return a.context.localeCompare(b.context);
  });
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
