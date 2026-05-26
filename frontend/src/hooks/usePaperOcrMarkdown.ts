"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

/** OCR markdown for tables/code extraction; fetched once per paper when OCR is ready. */
export function usePaperOcrMarkdown(paperId: string): string {
  const entry = useStore((s) => s.markdownByPaper[paperId]);
  const ocrStatus = useStore((s) => {
    const live = s.paper?.id === paperId ? s.paper : s.papersById[paperId];
    return live?.ocr_status;
  });
  const setPaperMarkdown = useStore((s) => s.setPaperMarkdown);

  useEffect(() => {
    if (!paperId || entry?.markdown?.trim()) return;
    if (ocrStatus !== "ready") return;

    let cancelled = false;
    void api.getPaperMarkdown(paperId).then((payload) => {
      if (!cancelled) setPaperMarkdown(paperId, payload);
    });
    return () => {
      cancelled = true;
    };
  }, [paperId, entry?.markdown, ocrStatus, setPaperMarkdown]);

  return (entry?.markdown || "").trim();
}
