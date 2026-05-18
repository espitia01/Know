"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/panel/SectionHeader";

/**
 * Stage 5 primitive: every titled block in the analysis pane wraps
 * its content in this so spacing, header chrome, and section
 * semantics stay consistent across panels. Replaces the per-panel
 * pattern of `<section><SectionHeader />...</section>` plus an ad-hoc
 * `space-y-2`/`space-y-3` on the wrapper.
 *
 * `id` is optional and only set when the section needs to be a scroll
 * target (e.g. summary anchors). `action` is a slot for an inline
 * "Clear" / "Hide" / "Retry" affordance — same contract as
 * `SectionHeader` so existing call sites can move over without
 * rewriting their action JSX.
 */
export function AnalysisSection({
  title,
  count,
  action,
  children,
  id,
  className,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={cn("space-y-3", className)}>
      <SectionHeader title={title} count={count} action={action} />
      {children}
    </section>
  );
}
