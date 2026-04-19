/**
 * Preprocess text containing LaTeX so that remark-math / rehype-katex can render it.
 *
 * 1. \( … \)  →  $ … $     (inline)
 * 2. \[ … \]  →  $$ … $$   (display)
 * 3. Bare LaTeX commands not already inside $ delimiters get wrapped in $ … $.
 */

const MATH_REGION =
  /(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*?\$)/g;

const MAX_WRAP_LENGTH = 8000;

function containsLatex(s: string): boolean {
  return /\\[A-Za-z]/.test(s) || /[_^]\{/.test(s) || /[_^][A-Za-z0-9]/.test(s);
}

/**
 * Iterative parser that finds bare LaTeX expressions and wraps them in $.
 * Avoids nested quantifiers to prevent ReDoS.
 */
function wrapBareLatex(segment: string): string {
  if (segment.length > MAX_WRAP_LENGTH || !containsLatex(segment)) return segment;

  const result: string[] = [];
  let i = 0;

  while (i < segment.length) {
    if (segment[i] === '\\' && i + 1 < segment.length && /[A-Za-z]/.test(segment[i + 1])) {
      const start = i;
      i = consumeLatexExpr(segment, i);
      const expr = segment.slice(start, i);
      if (containsLatex(expr) && expr.length > 1) {
        result.push('$' + expr.trim() + '$');
      } else {
        result.push(expr);
      }
    } else if (/[A-Za-z0-9]/.test(segment[i]) && i + 1 < segment.length && /[_^]/.test(segment[i + 1])) {
      const start = i;
      i++; // consume the letter
      i = consumeLatexExpr(segment, i);
      const expr = segment.slice(start, i);
      if (containsLatex(expr)) {
        result.push('$' + expr.trim() + '$');
      } else {
        result.push(expr);
      }
    } else {
      result.push(segment[i]);
      i++;
    }
  }

  return result.join('');
}

function consumeLatexExpr(s: string, i: number): number {
  const maxDepth = 10;
  const end = Math.min(s.length, i + 2000);

  while (i < end) {
    if (s[i] === '\\' && i + 1 < end && /[A-Za-z]/.test(s[i + 1])) {
      i++;
      while (i < end && /[A-Za-z]/.test(s[i])) i++;
    } else if (s[i] === '{') {
      i = consumeBraced(s, i, end, maxDepth);
    } else if (s[i] === '[' && i > 0 && s[i - 1] !== '\\') {
      i = consumeBracketed(s, i, end, maxDepth);
    } else if (s[i] === '_' || s[i] === '^') {
      i++;
      if (i < end && s[i] === '{') {
        i = consumeBraced(s, i, end, maxDepth);
      } else if (i < end && (s[i] === '\\' || /[A-Za-z0-9(]/.test(s[i]))) {
        if (s[i] === '\\') {
          i++;
          while (i < end && /[A-Za-z]/.test(s[i])) i++;
        } else {
          i++;
        }
      }
    } else if (/[=<>≈≡≤≥~+\-±×·,;!|]/.test(s[i])) {
      i++;
      while (i < end && s[i] === ' ') i++;
    } else if (s[i] === ' ' && i + 1 < end && (s[i + 1] === '\\' || /[_^{]/.test(s[i + 1]))) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

function consumeBraced(s: string, i: number, end: number, depth: number): number {
  if (depth <= 0 || i >= end || s[i] !== '{') return i;
  i++;
  while (i < end && s[i] !== '}') {
    if (s[i] === '{') {
      i = consumeBraced(s, i, end, depth - 1);
    } else if (s[i] === '\\') {
      i += 2;
    } else {
      i++;
    }
  }
  if (i < end && s[i] === '}') i++;
  return i;
}

function consumeBracketed(s: string, i: number, end: number, depth: number): number {
  if (depth <= 0 || i >= end || s[i] !== '[') return i;
  i++;
  while (i < end && s[i] !== ']') {
    if (s[i] === '[') {
      i = consumeBracketed(s, i, end, depth - 1);
    } else if (s[i] === '\\') {
      i += 2;
    } else {
      i++;
    }
  }
  if (i < end && s[i] === ']') i++;
  return i;
}

export function preprocessLatex(text: string): string {
  if (!text) return text;

  let s = text;

  s = s.replace(/\\\(/g, "$").replace(/\\\)/g, "$");
  s = s.replace(/\\\[/g, "\n$$\n").replace(/\\\]/g, "\n$$\n");

  s = s.replace(/(?<!\n)\$\$(?!\$)/g, '\n$$');
  s = s.replace(/\$\$(?!\n)/g, '$$\n');

  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  MATH_REGION.lastIndex = 0;
  while ((match = MATH_REGION.exec(s)) !== null) {
    if (match.index > lastIndex) {
      parts.push(wrapBareLatex(s.slice(lastIndex, match.index)));
    }
    parts.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < s.length) {
    parts.push(wrapBareLatex(s.slice(lastIndex)));
  }

  let result = parts.join("");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
