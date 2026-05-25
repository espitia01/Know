"use client";

import { useState, type ReactNode } from "react";
import { AnalysisAccordionRow } from "@/components/panel/AnalysisAccordionRow";

const COLLAPSE_CHAR_THRESHOLD = 600;

/**
 * Collapse long static prose; skip while streaming.
 *
 * Defaults to **open**: long selection answers, summary sections, etc.
 * are now visible by default — users were missing them behind a
 * "Read more" affordance.
 */
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
  const [open, setOpen] = useState(true);

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
