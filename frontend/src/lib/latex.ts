/**
 * Preprocess text containing LaTeX so that remark-math / rehype-katex can render it.
 *
 * 1. \( … \)  →  $ … $     (inline)
 * 2. \[ … \]  →  $$ … $$   (display)
 * 3. \begin{env}…\end{env} not inside delimiters → $$ … $$
 * 4. Bare LaTeX commands/expressions not inside $ → wrapped in $ or $$.
 */

const MATH_REGION =
  /(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*?\$)/g;

const MAX_WRAP_LENGTH = 4000;

function containsLatex(s: string): boolean {
  return /\\[A-Za-z]/.test(s) || /[_^]\{/.test(s) || /[_^][A-Za-z0-9]/.test(s);
}

const TEXT_COMMANDS = new Set([
  'textbf', 'textit', 'textrm', 'textsf', 'texttt', 'textsc',
  'emph', 'underline', 'text', 'mathrm', 'cite', 'ref', 'label',
  'section', 'subsection', 'paragraph', 'item', 'caption', 'footnote',
  'href', 'url', 'title', 'author', 'date', 'documentclass',
  'usepackage', 'newcommand', 'renewcommand', 'input', 'include',
  'begin', 'end',
]);

const DISPLAY_COMMANDS = new Set([
  'frac', 'dfrac', 'tfrac', 'sum', 'prod', 'int', 'iint', 'iiint', 'oint',
  'lim', 'sup', 'inf', 'max', 'min', 'sqrt', 'binom',
  'overset', 'underset', 'overbrace', 'underbrace',
  'left', 'right',
]);

// KaTeX accepts a fixed set of alignment environments. Several flavours
// LLMs love (`align`, `align*`, `eqnarray`, `multline`) either don't
// render at all inside `$$ ... $$` or only render under a tolerant mode.
// We rewrite them to KaTeX-native equivalents (`aligned`, `gathered`)
// before handing the string to remark-math/rehype-katex. The result is
// idempotent and visually identical to the input.
const ENV_ALIASES: Record<string, string> = {
  align: "aligned",
  "align*": "aligned",
  alignat: "aligned",
  "alignat*": "aligned",
  multline: "aligned",
  "multline*": "aligned",
  eqnarray: "aligned",
  "eqnarray*": "aligned",
  gather: "gathered",
  "gather*": "gathered",
  equation: "aligned",
  "equation*": "aligned",
};

function rewriteEnv(envName: string, body: string): { open: string; close: string } {
  const target = ENV_ALIASES[envName] ?? envName;
  // Some `aligned`-family environments require at least one `&` to
  // parse cleanly. Adding a leading "&" if none is present is a safe
  // no-op for already-aligned bodies and rescues the bare cases like
  // `\begin{align} (x+y)^4 = ... \end{align}` that were rendering as
  // raw text under our previous rules.
  if (target === "aligned" && !body.includes("&") && !body.includes("\\\\")) {
    return { open: `\\begin{aligned}&`, close: `\\end{aligned}` };
  }
  return { open: `\\begin{${target}}`, close: `\\end{${target}}` };
}

function tryConsumeEnvironment(segment: string, pos: number): { end: number; match: string } | null {
  const rest = segment.slice(pos);
  // Match the env name including a trailing `*` so `align*`, `equation*`
  // etc. are caught.
  const m = rest.match(/^\\begin\{([A-Za-z]+\*?)\}([\s\S]*?)\\end\{\1\}/);
  if (!m) return null;
  const [, name, body] = m;
  const { open, close } = rewriteEnv(name, body);
  return { end: pos + m[0].length, match: `${open}${body}${close}` };
}

function isDisplayMath(expr: string): boolean {
  const cmdRegex = /\\([A-Za-z]+)/g;
  let m;
  while ((m = cmdRegex.exec(expr)) !== null) {
    if (DISPLAY_COMMANDS.has(m[1])) return true;
  }
  return false;
}

function wrapBareLatex(segment: string): string {
  if (segment.length > MAX_WRAP_LENGTH || !containsLatex(segment)) return segment;

  const result: string[] = [];
  let i = 0;

  while (i < segment.length) {
    if (segment[i] === '\\' && i + 1 < segment.length && /[A-Za-z]/.test(segment[i + 1])) {
      const env = tryConsumeEnvironment(segment, i);
      if (env) {
        result.push('\n$$\n' + env.match + '\n$$\n');
        i = env.end;
        continue;
      }

      const cmdMatch = segment.slice(i).match(/^\\([A-Za-z]+)/);
      if (cmdMatch && TEXT_COMMANDS.has(cmdMatch[1])) {
        result.push(cmdMatch[0]);
        i += cmdMatch[0].length;
        continue;
      }

      const start = i;
      i = consumeLatexExpr(segment, i);
      if (i === start) { result.push(segment[i]); i++; continue; }
      const expr = segment.slice(start, i).trim();
      if (expr.length > 1 && containsLatex(expr)) {
        if (isDisplayMath(expr)) {
          result.push('\n$$\n' + expr + '\n$$\n');
        } else {
          result.push('$' + expr + '$');
        }
      } else {
        result.push(segment.slice(start, i));
      }
    } else if (/[A-Za-z0-9]/.test(segment[i]) && i + 1 < segment.length && /[_^]/.test(segment[i + 1])) {
      const start = i;
      i++;
      i = consumeLatexExpr(segment, i);
      const expr = segment.slice(start, i).trim();
      if (containsLatex(expr)) {
        result.push('$' + expr + '$');
      } else {
        result.push(segment.slice(start, i));
      }
    } else {
      result.push(segment[i]);
      i++;
    }
  }

  return result.join('');
}

function consumeLatexExpr(s: string, i: number): number {
  const start = i;
  const maxDepth = 10;
  const end = Math.min(s.length, i + 2000);

  while (i < end) {
    const c = s[i];

    if (c === '\\' && i + 1 < end && /[A-Za-z]/.test(s[i + 1])) {
      const rest = s.slice(i, Math.min(i + 30, end));
      const cmdMatch = rest.match(/^\\([A-Za-z]+)/);
      if (cmdMatch && TEXT_COMMANDS.has(cmdMatch[1])) break;
      i++;
      while (i < end && /[A-Za-z]/.test(s[i])) i++;
    } else if (c === '{') {
      i = consumeBraced(s, i, end, maxDepth);
    } else if (c === '[' && i > 0 && s[i - 1] !== '\\') {
      i = consumeBracketed(s, i, end, maxDepth);
    } else if (c === '_' || c === '^') {
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
    } else if (/[=<>≈≡≤≥~+\-±×·,;!|()\/0-9*:]/.test(c)) {
      i++;
    } else if (/[A-Za-z]/.test(c)) {
      const next = i + 1 < end ? s[i + 1] : '';
      if (/[_^=\\{()+\-*\/|,;:<>0-9]/.test(next)) {
        i++;
      } else if (next === ' ' && i + 2 < end && /[_^\\{=+\-<>|]/.test(s[i + 2])) {
        i++;
      } else {
        break;
      }
    } else if (c === ' ') {
      const next = i + 1 < end ? s[i + 1] : '';
      if (/[\\_{^|=<>+\-±×·!0-9]/.test(next)) {
        i++;
      } else if (/[A-Za-z]/.test(next) && i + 2 < end && /[_^=\\{(+\-*\/|,]/.test(s[i + 2])) {
        i++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  while (i > start && /[\s,]/.test(s[i - 1])) i--;

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

  // Rewrite KaTeX-incompatible environments inside *any* math region —
  // including the ones the LLM already wrapped in $$..$$ itself. We
  // can't do this inside `wrapBareLatex` alone because that path only
  // sees text *outside* existing math regions.
  s = s.replace(
    /\\begin\{([A-Za-z]+\*?)\}([\s\S]*?)\\end\{\1\}/g,
    (full, name: string, body: string) => {
      if (!ENV_ALIASES[name]) return full;
      const { open, close } = rewriteEnv(name, body);
      return `${open}${body}${close}`;
    },
  );

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
