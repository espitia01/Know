"use client";

import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { preprocessLatex } from "@/lib/latex";

interface MdProps {
  children: string;
  className?: string;
}

export function Md({ children, className }: MdProps) {
  return (
    <div className={className ?? "analysis-content"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
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
