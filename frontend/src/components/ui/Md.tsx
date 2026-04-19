"use client";

import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { preprocessLatex } from "@/lib/latex";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div || []), "className", "style"],
    span: [...(defaultSchema.attributes?.span || []), "className", "style"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext",
    "msup", "msub", "msubsup", "mfrac", "mroot", "msqrt", "mover",
    "munder", "munderover", "mtable", "mtr", "mtd", "mpadded",
    "mspace", "annotation", "menclose",
  ],
};

interface MdProps {
  children: string;
  className?: string;
}

export function Md({ children, className }: MdProps) {
  return (
    <div className={className ?? "analysis-content"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeSanitize, sanitizeSchema]]}
        components={{
          a: ({ href, children: linkChildren }) => (
            <a
              href={href && !href.startsWith("javascript:") ? href : "#"}
              target="_blank"
              rel="noopener noreferrer"
            >
              {linkChildren}
            </a>
          ),
        }}
      >
        {preprocessLatex(children)}
      </ReactMarkdown>
    </div>
  );
}
