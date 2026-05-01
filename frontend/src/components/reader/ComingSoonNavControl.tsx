"use client";

import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Navbar controls that are temporarily unavailable. Tooltip uses Base UI
 * so “Coming soon” copy shows reliably (native `title` on wrappers often
 * fails when inner surfaces use `pointer-events-none`).
 */
export function ComingSoonNavControl({
  label,
  tooltip,
  icon,
}: {
  label: string;
  tooltip: string;
  icon: ReactNode;
}) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={`${label}. ${tooltip}`}
          className="inline-flex max-w-full shrink-0 cursor-not-allowed select-none rounded-lg border border-border/35 bg-muted/18 px-2 py-1.5 text-[11px] font-medium text-muted-foreground/90 shadow-none outline-none transition-opacity hover:opacity-95 dark:border-border/30 dark:bg-muted/12"
        >
          <span className="inline-flex max-w-full items-center gap-1">
            <svg
              className="h-3 w-3 shrink-0 text-muted-foreground/70"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.75}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
              />
            </svg>
            <span className="shrink-0 opacity-95">{icon}</span>
            <span className="hidden min-w-0 truncate sm:inline">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[14rem] text-center">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
