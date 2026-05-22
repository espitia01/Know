/**
 * Section-aware paper excerpts for migrated Next.js streaming routes.
 * Port of `backend/app/services/paper_excerpt.py` with profile-specific
 * section selection (summary / prepare / selection).
 */

export type ExcerptProfile = "prepare" | "summary" | "selection";

const HEADING_RE =
  /^\s*(?:\d+(?:\.\d+)*\s+)?(abstract|introduction|background|related work|method[s]?|approach|model|theor(?:y|etical)|experiment[s]?|result[s]?|evaluation|discussion|conclusion[s]?|future work|limitations)\b/im;

const BANNED_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u200e", "\u200f",
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
  "\u2066", "\u2067", "\u2068", "\u2069",
  "\ufeff",
]);

const PRIORITY = [
  "abstract",
  "introduction",
  "conclusion",
  "conclusions",
  "discussion",
  "result",
  "results",
  "evaluation",
  "experiment",
  "experiments",
  "method",
  "methods",
  "approach",
  "model",
  "theory",
  "theoretical",
  "background",
  "related work",
  "future work",
  "limitations",
] as const;

function sanitizeText(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (BANNED_CHARS.has(ch)) continue;
    if (ch < " " && ch !== "\n" && ch !== "\t") continue;
    out += ch;
  }
  return out.trim();
}

function sectionPriority(name: string): number {
  const key = name.toLowerCase().trim();
  for (let i = 0; i < PRIORITY.length; i++) {
    const p = PRIORITY[i];
    if (key.startsWith(p) || key.includes(p)) return i;
  }
  return PRIORITY.length;
}

function firstParagraphs(text: string, n = 2, maxChars = 1200): string {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let total = 0;
  for (const p of parts.slice(0, n)) {
    if (total + p.length > maxChars) {
      const remaining = maxChars - total;
      if (remaining > 80) out.push(p.slice(0, remaining));
      break;
    }
    out.push(p);
    total += p.length + 2;
  }
  return out.join("\n\n");
}

function isFullSection(profile: ExcerptProfile, nameLower: string): boolean {
  if (profile === "prepare") {
    return (
      nameLower.includes("abstract") ||
      nameLower.includes("introduction") ||
      nameLower.startsWith("conclusion") ||
      nameLower.includes("future work")
    );
  }
  if (profile === "summary") {
    return (
      nameLower.includes("abstract") ||
      nameLower.includes("method") ||
      nameLower.includes("approach") ||
      nameLower.includes("model") ||
      nameLower.includes("experiment") ||
      nameLower.includes("result") ||
      nameLower.includes("evaluation") ||
      nameLower.includes("discussion") ||
      nameLower.startsWith("conclusion")
    );
  }
  // selection
  return nameLower.includes("abstract") || nameLower.includes("introduction");
}

function pieceForSection(
  profile: ExcerptProfile,
  name: string,
  body: string,
  full: boolean,
): string {
  const nameL = name.toLowerCase();
  if (full || isFullSection(profile, nameL)) return body;
  if (profile === "summary") {
    return firstParagraphs(body, 2, 1400);
  }
  return firstParagraphs(body, profile === "selection" ? 1 : 2, 1400);
}

export function buildPaperExcerpt(
  rawText: string,
  opts: { maxChars: number; profile: ExcerptProfile },
): string {
  const text = sanitizeText(rawText || "");
  const { maxChars, profile } = opts;
  if (!text) return "";
  if (text.length <= maxChars) return text;

  const head = text.slice(0, Math.min(1000, text.length));
  const matches: { start: number; name: string }[] = [];
  const re = new RegExp(HEADING_RE.source, HEADING_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push({ start: m.index, name: m[1] || "" });
  }

  if (matches.length < 2) {
    return text.slice(0, maxChars);
  }

  type Section = { name: string; body: string; prio: number; order: number };
  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].start;
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const name = matches[i].name;
    const body = text.slice(start, end).trim();
    sections.push({ name, body, prio: sectionPriority(name), order: i });
  }

  // Pick which sections fit using priority (so high-signal sections survive
  // a tight budget), then render them in the paper's original order — that
  // way the excerpt still reads like the source instead of an LLM-only,
  // Methods-first reshuffle that a human auditor would find disorienting.
  const byPriority = [...sections].sort((a, b) => a.prio - b.prio);
  const selected = new Map<number, { name: string; body: string }>();
  let used = head.length + 2;
  for (const { name, body, order } of byPriority) {
    const nameL = name.toLowerCase();
    const full = isFullSection(profile, nameL);
    const piece = pieceForSection(profile, name, body, full);
    const block = `## ${name}\n${piece}`.trim();
    if (used + block.length + 4 > maxChars) continue;
    selected.set(order, { name, body: block });
    used += block.length + 4;
    if (used >= maxChars - 200) break;
  }
  const chunks = [...selected.keys()]
    .sort((a, b) => a - b)
    .map((k) => selected.get(k)!.body);

  if (chunks.length === 0) {
    return text.slice(0, maxChars);
  }

  const combined = `${head}\n\n${chunks.join("\n\n")}`;
  return combined.length <= maxChars ? combined : combined.slice(0, maxChars);
}
