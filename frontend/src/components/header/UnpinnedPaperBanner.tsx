"use client";

import { OverflowMenu } from "@/components/analysis/OverflowMenu";
import { MAX_SESSION_PAPERS } from "@/lib/workspaceFeatureFlags";

interface UnpinnedPaperBannerProps {
  sessionPapers: { id: string; title: string }[];
  activePaperTitle: string;
  onPinSwap: (droppedId: string) => void;
}

/** Shown when the reader paper is not pinned and the workspace session is at cap. */
export function UnpinnedPaperBanner({
  sessionPapers,
  activePaperTitle,
  onPinSwap,
}: UnpinnedPaperBannerProps) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-border/45 bg-muted/[0.08] px-4 py-2 text-[var(--text-xs)] text-muted-foreground/90"
    >
      <span>
        This paper isn&apos;t in your workspace yet — your session is full ({MAX_SESSION_PAPERS} of{" "}
        {MAX_SESSION_PAPERS}). Remove a tab to pin it.
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-medium text-muted-foreground/70 tabular-nums">
          {sessionPapers.length} / {MAX_SESSION_PAPERS}
        </span>
        <OverflowMenu
          ariaLabel="Pin this paper"
          align="end"
          buttonProps={{
            type: "button",
            className:
              "rounded-md border border-border/55 bg-background/80 px-2.5 py-1 text-[var(--text-xs)] font-semibold text-foreground/90 transition-colors hover:border-border-strong hover:bg-accent/35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          }}
          triggerInner="Pin this paper…"
        >
          <div className="min-w-[200px] py-1">
            <p className="px-2 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
              Replace a tab with &ldquo;{activePaperTitle.length > 24 ? `${activePaperTitle.slice(0, 24)}…` : activePaperTitle}&rdquo;
            </p>
            {sessionPapers.map((sp) => (
              <button
                key={sp.id}
                type="button"
                onClick={() => onPinSwap(sp.id)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[var(--text-xs)] text-foreground transition-colors hover:bg-accent/50 motion-safe:duration-150"
              >
                <span className="min-w-0 flex-1 truncate">{sp.title}</span>
                <svg
                  className="h-3 w-3 shrink-0 text-muted-foreground/70"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ))}
          </div>
        </OverflowMenu>
      </div>
    </div>
  );
}
