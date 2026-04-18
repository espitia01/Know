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
      >
        {preprocessLatex(children)}
      </ReactMarkdown>
    </div>
  );
}
