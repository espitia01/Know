/**
 * Tags display KaTeX spans that look like equations (relational operator)
 * with `know-eq-card` so CSS can show the inset “card” only for those.
 */
import { visit } from "unist-util-visit";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

function hastTextCollect(node: HastNode | undefined): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;
  if (Array.isArray(node.children)) return node.children.map(hastTextCollect).join("");
  return "";
}

function classArray(node: HastNode): string[] {
  const cls = node.properties?.className;
  if (Array.isArray(cls)) return cls.flatMap((c) => String(c).split(/\s+/)).filter(Boolean);
  if (typeof cls === "string") return cls.split(/\s+/).filter(Boolean);
  return [];
}

function setClasses(node: HastNode, classes: string[]) {
  node.properties = node.properties ?? {};
  node.properties.className = classes;
}

/** Relational formulas get the boxed card — not standalone matrices/lists without "=" etc. */
const LOOKS_LIKE_EQUATION = /[=≈≠≤≥≡≷∝±]/;

export function rehypeKatexEquationCards() {
  return (tree: HastNode) => {
    visit(tree, "element", (node: HastNode) => {
      if (node.tagName !== "span") return;
      const list = classArray(node);
      if (!list.includes("katex-display")) return;
      const raw = hastTextCollect(node);
      if (!LOOKS_LIKE_EQUATION.test(raw)) return;
      setClasses(node, [...new Set([...list, "know-eq-card"])]);
    });
  };
}
