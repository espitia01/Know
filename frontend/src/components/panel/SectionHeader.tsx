"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHeader({
  title,
  count,
  action,
  className,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-2.5 flex min-h-[1.25rem] items-baseline justify-between gap-2 border-b border-border/40 pb-2",
        className
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="shrink-0 text-[var(--text-sm)] font-semibold tracking-[-0.02em] text-foreground">
          {title}
        </h2>
        {count != null && (
          <span
            className="font-mono text-[var(--text-2xs)] font-medium tabular-nums text-muted-foreground/72"
            aria-hidden
          >
            {count}
          </span>
        )}
      </div>
      {action != null && (
        <div className="shrink-0 [&_button]:outline-offset-2 [&_button]:focus-visible:outline [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-ring">
          {action}
        </div>
      )}
    </div>
  );
}
