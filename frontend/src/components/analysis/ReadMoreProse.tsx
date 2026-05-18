"use client";

import { useState, type ReactNode } from "react";
import { AnalysisAccordionRow } from "@/components/panel/AnalysisAccordionRow";

const COLLAPSE_CHAR_THRESHOLD = 600;

/** Collapse long static prose; skip while streaming (Bug 5). */
export function ReadMoreProse({
  children,
  markdown,
  streaming,
}: {
  children: ReactNode;
  markdown: string;
  streaming?: boolean;
}) {
  const long = markdown.length > COLLAPSE_CHAR_THRESHOLD;
  const [open, setOpen] = useState(false);

  if (streaming || !long) {
    return <>{children}</>;
  }

  return (
    <AnalysisAccordionRow
      title="Read more"
      open={open}
      onOpenChange={setOpen}
    >
      {children}
    </AnalysisAccordionRow>
  );
}
