"use client";

import { OwlSpinner } from "@/components/ui/OwlSpinner";

interface PaperLoadingScreenProps {
  title?: string;
  subtitle?: string;
  /** When set, shown as a secondary line under the subtitle. */
  detail?: string;
}

export function PaperLoadingScreen({
  title = "Opening paper",
  subtitle = "Loading PDF and analysis…",
  detail,
}: PaperLoadingScreenProps) {
  return (
    <div className="flex h-screen flex-1 items-center justify-center bg-background text-foreground">
      <div className="mx-auto w-full max-w-sm px-6 text-center motion-safe:animate-fade-in">
        <div className="mx-auto mb-6 text-foreground/80">
          <OwlSpinner size={56} label={title} />
        </div>
        <p className="font-display text-[15px] font-semibold tracking-[-0.02em] text-foreground">
          {title}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>
        {detail ? (
          <p className="mt-1 text-[12px] text-muted-foreground/75">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
