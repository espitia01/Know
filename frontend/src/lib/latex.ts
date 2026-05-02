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

function normalizeUnicodeMath(s: string): string {
  return s
    .replace(/\u2212/g, "-")
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\u00a0/g, " ");
}

/** Greek capitals commonly emitted as Unicode instead of $\\Gamma$-style macros. */
function unicodeCapGreekToLatex(s: string): string {
  let t = s;
  const map: Record<string, string> = {
    Γ: "\\Gamma ",
    Δ: "\\Delta ",
    Θ: "\\Theta ",
    Λ: "\\Lambda ",
    Ξ: "\\Xi ",
    Π: "\\Pi ",
    Σ: "\\Sigma ",
    Φ: "\\Phi ",
    Ψ: "\\Psi ",
    Ω: "\\Omega ",
  };
  for (const [k, v] of Object.entries(map)) {
    if (t.includes(k)) t = t.split(k).join(v);
  }
  return t;
}

function hasEquationFragmentSignature(text: string): boolean {
  if (/\\/.test(text)) return true;
  const greekOrSymbol = /[\u0393-\u03C9]|[ΓΔΘΛΣΦΨΩ\u03BC]/.test(text);
  if (greekOrSymbol && (/[=<>|]/.test(text) || /\d/.test(text))) return true;
  if (/[|‖∣]/.test(text) && (/[=<>≈≤≥\-]/.test(text) || /[A-Za-z]/.test(text))) return true;
  return false;
}

/** Collapse LLM / PDF-paste line breaks that split one LaTeX expression across many short lines. */
function collapseBrokenDisplayMath(s: string): string {
  const lines = s.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "") break;
      if (t.length > 14) break;
      if (/^\d+\.[\s)]/.test(t)) break;
      if (/^[-*•]\s/.test(t)) break;
      if (/^#{1,6}\s/.test(t)) break;
      j++;
    }
    const slice = lines.slice(i, j);
    const joined = slice.join("\n");
    const n = j - i;
    if ((n >= 5 && /\\/.test(joined)) || (n >= 4 && hasEquationFragmentSignature(joined))) {
      out.push(slice.map((l) => l.trim()).join(" "));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/** Lines that are Unicode-heavy equation fragments without backslashes yet. */
function collapseUnicodeEquationLines(s: string): string {
  const lines = s.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === "") break;
      if (t.length > 22) break;
      if (/^\d+\.[\s)]/.test(t)) break;
      if (/^[-*•]\s/.test(t)) break;
      if (/^#{1,6}\s/.test(t)) break;
      if (!/^[\s\d.|A-Za-z\u0391-\u03C9_^²³⁺⁴⁵⁻+=<>≤≥≈≠Å\u00C5å\u2212µ∣‖°·]+$/.test(t)) break;
      j++;
    }
    const slice = lines.slice(i, j);
    const joined = slice.join("\n");
    const n = j - i;
    if (n >= 4 && hasEquationFragmentSignature(joined)) {
      out.push(slice.map((l) => l.trim()).join(" "));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

function repairBracketDollarSubscripts(s: string): string {
  return s.replace(
    /\[\s*\$\s*([^$\n]+?)\s*\$\s*\]\s*_\{((?:[^{}]|\{[^{}]*\})*)\}/g,
    (_m, inner: string, subRaw: string) => {
      const subClean = String(subRaw)
        .replace(/\$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return `\n$$\\left[${String(inner).trim()}\\right]_{${subClean}}\n$$\n`;
    },
  );
}

function repairAngstromSuperscriptOutsideMath(s: string): string {
  return s.replace(/\u00C5\s*\$\^\{-1\}\$/g, "$\\mathrm{\\AA}^{-1}$");
}

function repairSubscriptEmbeddedDollars(s: string): string {
  return s.replace(/\]\s*_\{([^}]*)\}/g, (_full, inner: string) => {
    if (!inner || typeof inner !== "string" || !inner.includes("$")) return _full;
    const flat = inner
      .replace(/\$\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!flat) return _full;
    return `]_{${flat}}`;
  });
}

/** Lines like "|$\Gamma..." confuse GFM table parsing — drop a leading pipe before math. */
function softenLeadingPipeBeforeMath(s: string): string {
  return s.replace(/(^|\n)(\s*)\|(\s*\$)/g, "$1$2$3");
}

/** Orphan enumerated equation row prior to messy math (e.g. summary key_equations). */
function stripOrphanEquationIndexLine(s: string): string {
  return s.replace(/^\s*\d{1,2}\s*[\.)]\s*\n(?=\s*\|?\$)/gm, "");
}


function promoteHeavyInlineMathToDisplay(s: string): string {
  return s.replace(/\$(?!\$)((?:\\.|\$\$|[^$\n])+?)\$(?!\$)/g, (full, inner: string) => {
    const t = String(inner).trim();
    if (!t || /\n/.test(t)) return full;
    const textUnit =
      /^\\text(?:rm)?\{[^}]{0,48}\}(\s*\^(?:\{[^}]+\}|\w+))?$/i.test(t) && !/\\frac|\\sum|\\prod|\\left|\\right|\\int/.test(t);
    if (textUnit && t.length < 100) return full;
    const heavy =
      /\\(?:left|right|frac|dfrac|sum|prod|mathcal|mathrm|Gamma|Omega|Xi|Theta|Sigma|Lambda|Pi)|\\text\s*\{/.test(
        t,
      ) ||
      /\\left\[|\\right]/.test(t) ||
      (/\|/.test(t) && /[=<>]/.test(t)) ||
      t.length >= 72;
    if (!heavy) return full;
    return `\n$$\n${t}\n$$\n`;
  });
}

function wrapLikelyDisplayEquations(body: string): string {
  const paras = body.split(/\n\n+/);
  return paras
    .map((para) => {
      const t = para.trim();
      if (!t || /\$\$/.test(t) || t.length > 900) return para;
      if (/\\begin\{aligned|\\begin\{equation|\\begin\{gather/.test(t)) {
        return `\n$$\n${t}\n$$\n`;
      }
      if (/\\text\s*\{/.test(t) && /[_^]/.test(t) && /[<>≤≥≈≠=]/.test(t)) {
        return `\n$$\n${t}\n$$\n`;
      }
      if (
        /\\(?:Gamma|Delta|Omega|Sigma|Lambda|Pi|Theta|Xi|Psi|Phi)/.test(t) &&
        /\|/.test(t) &&
        /[=<>]/.test(t)
      ) {
        return `\n$$\n${t}\n$$\n`;
      }
      if (
        /]_{/.test(t) &&
        /[<>≤≥≈≠=]/.test(t) &&
        (/\\(?:text|mathrm|mathcal|left|right)/.test(t) || /\^|_/.test(t))
      ) {
        return `\n$$\n${t}\n$$\n`;
      }
      return para;
    })
    .join("\n\n");
}

function containsLatex(s: string): boolean {
  return /\\[A-Za-z]/.test(s) || /[_^]\{/.test(s) || /[_^][A-Za-z0-9]/.test(s);
}

const TEXT_COMMANDS = new Set([
  'textbf', 'textit', 'textrm', 'textsf', 'texttt', 'textsc',
  'emph', 'underline',
  // `\text`, `\mathrm`, `\mathcal` are math-mode commands in KaTeX; if we pass
  // them through as plain prose, `\text{…}` never reaches a math span and
  // renders literally or breaks. Let `wrapBareLatex` fold them into `$…$`.
  'cite', 'ref', 'label',
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
  split: "aligned",
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

  let s = normalizeUnicodeMath(text);
  s = unicodeCapGreekToLatex(s);
  s = stripOrphanEquationIndexLine(s);
  s = softenLeadingPipeBeforeMath(s);
  s = collapseBrokenDisplayMath(s);
  s = collapseUnicodeEquationLines(s);
  s = repairBracketDollarSubscripts(s);
  s = repairSubscriptEmbeddedDollars(s);
  s = repairAngstromSuperscriptOutsideMath(s);
  s = promoteHeavyInlineMathToDisplay(s);

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
  result = wrapLikelyDisplayEquations(result);
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
