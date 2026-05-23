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
        <div className="mx-auto mb-5 text-foreground/70">
          <OwlSpinner size={28} label={title} />
        </div>
        <p className="font-display text-[14.5px] font-medium tracking-[-0.01em] text-foreground">
          {title}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground/85">{subtitle}</p>
        {detail ? (
          <p className="mt-1 text-[11.5px] text-muted-foreground/70">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
