"use client";

import * as React from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { cn } from "@/lib/utils";

/**
 * Single analysis-pane disclosure — shared chrome for Q&A answers and
 * selection follow-ups so spacing, borders, and motion stay consistent.
 */
export function AnalysisAccordionRow({
  open,
  onOpenChange,
  title,
  leading,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  leading?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange}>
      <div
        className={cn(
          "overflow-hidden rounded-[var(--radius-lg)] border border-border/50 bg-card/35 shadow-none dark:bg-card/22",
          className,
        )}
      >
        <Collapsible.Trigger
          className={cn(
            "group flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left outline-none",
            "transition-colors duration-150 hover:bg-accent/20",
            "focus-visible:ring-2 focus-visible:ring-ring/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          {leading != null ? <span className="flex shrink-0 items-start pt-0.5">{leading}</span> : null}
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug tracking-tight text-foreground">
            {title}
          </span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/55 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-[panel-open]:rotate-180"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </Collapsible.Trigger>
        <Collapsible.Panel className="border-t border-border/50 bg-muted/[0.04] px-3 py-3 text-[13px] leading-relaxed text-foreground/90 dark:bg-muted/[0.08]">
          {children}
        </Collapsible.Panel>
      </div>
    </Collapsible.Root>
  );
}
