import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "react-markdown",
    "rehype-katex",
    "remark-math",
    "remark-parse",
    "unified",
    "hast-util-to-jsx-runtime",
    "hast-util-from-html-isomorphic",
    "hast-util-to-text",
    "hast-util-is-element",
    "hast-util-whitespace",
    "hastscript",
    "unist-util-visit-parents",
    "devlop",
    "mdast-util-from-markdown",
    "mdast-util-to-hast",
    "micromark",
    "style-to-js",
    "katex",
    "react-pdf",
  ],
  turbopack: {
    resolveAlias: {
      canvas: { browser: "./empty-module.js" },
    },
  },
};

export default nextConfig;
