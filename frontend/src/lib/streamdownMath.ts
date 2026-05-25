/**
 * Streamdown / @streamdown/math delimiter repairs for LLM markdown.
 *
 * Migrated analysis paths (selection, summary, QA) use this instead of the
 * legacy `preprocessLatex` → remark-math pipeline. Keep repairs conservative
 * and idempotent — only fix well-known GPT/Mistral failure modes.
 */

const MATH_REGION =
  /(\$\$[\s\S]*?\$\$|(?<!\$)\$(?!\$)(?:\\.|[^$])*?(?<!\$)\$(?!\$))/g;

function looksLikeBareDisplayMath(expr: string): boolean {
  const t = expr.trim();
  if (!t || t.length < 4) return false;
  return (
    (/\\(?:sum|binom|frac|prod|int|substack|left|right|mathcal|mathrm)/.test(t) ||
      /[_^{}]/.test(t)) &&
    (/[=+\-*/^]|\\(?:sum|binom|frac)/.test(t) || /\([A-Za-z0-9+-]+\)\^/.test(t))
  );
}

/** GPT closes display math with `.$$` instead of `$$` (with or without an opener). */
function repairPeriodDisplayClose(input: string): string {
  // Normalise `$$(body).$$` → `$$\nbody.\n$$` first.
  let out = input.replace(
    /\$\$([\s\S]*?)\.\$\$/g,
    (_full, body: string) => {
      const trimmed = String(body).trim();
      if (!trimmed || !looksLikeBareDisplayMath(trimmed)) return _full;
      return `$$\n${trimmed}.\n$$`;
    },
  );

  const parts: string[] = [];
  let last = 0;
  MATH_REGION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_REGION.exec(out)) !== null) {
    if (m.index > last) parts.push(repairOrphanPeriodInPlain(out.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < out.length) parts.push(repairOrphanPeriodInPlain(out.slice(last)));
  return parts.join("");
}

function repairOrphanPeriodInPlain(segment: string): string {
  return segment.replace(
    /(^|[^\\$])(\\(?:\\.|[^$]){5,}?)\.\$\$/g,
    (full, before: string, expr: string) => {
      const trimmed = expr.trim();
      if (!trimmed || trimmed.includes("$$")) return full;
      if (!looksLikeBareDisplayMath(trimmed)) return full;
      return `${before}\n$$\n${trimmed}.\n$$`;
    },
  );
}

function repairOrphanDisplayCloseInPlain(segment: string): string {
  return segment.replace(
    /(^|[^\\$])(\\(?:\\.|[^$]){5,}?)\$\$(?!\$)/g,
    (full, before: string, expr: string) => {
      const trimmed = expr.trim();
      if (!trimmed || trimmed.includes("$$")) return full;
      if (!looksLikeBareDisplayMath(trimmed)) return full;
      if (
        !/\\(?:left|right|frac|sum|binom|int|prod|mathbf|mathrm|omega)/.test(trimmed) &&
        trimmed.length < 24
      ) {
        return full;
      }
      return `${before}\n$$\n${trimmed}\n$$`;
    },
  );
}

/** GPT closes display math with `$$` but never opens it (`\\left[...\\right]$$`). */
function repairOrphanDisplayClose(input: string): string {
  const parts: string[] = [];
  let last = 0;
  MATH_REGION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_REGION.exec(input)) !== null) {
    if (m.index > last) parts.push(repairOrphanDisplayCloseInPlain(input.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < input.length) parts.push(repairOrphanDisplayCloseInPlain(input.slice(last)));
  return parts.join("");
}

/** GPT sometimes closes an opened `$$` block with `,$$` instead of `$$`. */
function repairCommaDisplayClose(input: string): string {
  return input.replace(
    /\$\$([\s\S]*?),(\s*)\$\$(?!\$)/g,
    (_full, body: string, trail: string) => `$$\n${String(body).trim()},${trail}\n$$`,
  );
}

function wrapBareInPlain(segment: string): string {
  return segment.replace(
    /(^|\n)([^\n$]{8,}?\\(?:sum|binom|frac|prod|int|substack)\{?[^\n$]{4,})(?=\n|$)/g,
    (full, prefix: string, expr: string) => {
      const trimmed = expr.trim();
      if (!looksLikeBareDisplayMath(trimmed)) return full;
      if (/\$\$/.test(trimmed)) return full;
      return `${prefix}$$\n${trimmed}\n$$`;
    },
  );
}

function wrapBareDisplayMathRuns(input: string): string {
  const parts: string[] = [];
  let last = 0;
  MATH_REGION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_REGION.exec(input)) !== null) {
    if (m.index > last) parts.push(wrapBareInPlain(input.slice(last, m.index)));
    parts.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < input.length) parts.push(wrapBareInPlain(input.slice(last)));
  return parts.join("");
}

function balanceInlineDollars(line: string): string {
  const withoutDisplay = line.replace(/\$\$[\s\S]*?\$\$/g, "");
  const count = (withoutDisplay.match(/\$/g) || []).length;
  if (count % 2 === 1) return `${line}$`;
  return line;
}

export function sanitizeStreamdownMath(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(/\${3,}/g, "$$$$");
  out = out.replace(/\\\[/g, "\n$$\n").replace(/\\\]/g, "\n$$\n");
  out = out.replace(/\\\(/g, "$").replace(/\\\)/g, "$");
  out = out.replace(/\\\$/g, "$");
  out = repairPeriodDisplayClose(out);
  out = repairOrphanDisplayClose(out);
  out = repairCommaDisplayClose(out);
  out = wrapBareDisplayMathRuns(out);
  out = out.split("\n").map(balanceInlineDollars).join("\n");
  return out;
}
