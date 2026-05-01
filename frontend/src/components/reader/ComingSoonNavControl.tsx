"use client";

import type { ReactNode } from "react";

/**
 * Navbar controls that are temporarily unavailable. Disabled native
 * buttons swallow hover in several browsers, so we use a non-interactive
 * inner surface with `pointer-events-none` and put the tooltip on the
 * wrapper so “Coming soon” copy reliably appears on hover.
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
    <span
      title={tooltip}
      className="relative inline-flex max-w-full shrink-0 cursor-not-allowed select-none rounded-lg"
    >
      <span
        role="group"
        aria-label={`${label}. ${tooltip}`}
        className="pointer-events-none inline-flex max-w-full items-center gap-1 rounded-lg border border-border/60 bg-muted/35 px-2 py-1.5 text-[11px] font-medium text-muted-foreground shadow-none dark:bg-muted/25"
      >
        <svg
          className="h-3 w-3 shrink-0 text-muted-foreground/80"
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
        <span className="shrink-0 opacity-90">{icon}</span>
        <span className="hidden min-w-0 truncate sm:inline">{label}</span>
      </span>
    </span>
  );
}
