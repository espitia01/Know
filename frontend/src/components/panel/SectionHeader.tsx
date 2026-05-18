"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionHeader({
  title,
  count,
  action,
  className,
  eyebrow = false,
  size = "primary",
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  className?: string;
  /** Uppercase eyebrow for legacy chrome rows (History, Follow-ups). */
  eyebrow?: boolean;
  /** Primary section titles vs nested. */
  size?: "primary" | "nested";
}) {
  return (
    <div
      className={cn(
        "mb-0 flex min-h-[1.25rem] items-baseline justify-between gap-2 pb-1.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {eyebrow ? (
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">
            {title}
          </span>
        ) : (
          <h2
            className={cn(
              "shrink-0 font-display tracking-[-0.02em] text-foreground",
              size === "primary"
                ? "text-[var(--text-md)] font-medium"
                : "text-[var(--text-sm)] font-medium",
            )}
          >
            {title}
          </h2>
        )}
        {count != null && (
          <span
            className="rounded-full bg-muted/40 px-1.5 py-px font-mono text-[10px] font-medium tabular-nums text-muted-foreground/80"
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
