"use client";

import Image from "next/image";

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
        <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-border/50 bg-card/30 shadow-[var(--shadow-xs)] dark:bg-card/22">
          <Image src="/logo.png" alt="" width={24} height={24} className="rounded-md opacity-90" aria-hidden />
        </div>
        <p className="font-display text-[15px] font-semibold tracking-[-0.02em] text-foreground">
          {title}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>
        {detail ? (
          <p className="mt-1 text-[12px] text-muted-foreground/75">{detail}</p>
        ) : null}
        <div className="mx-auto mt-6 h-1 w-28 overflow-hidden rounded-full bg-border/50">
          <div className="h-full w-2/5 rounded-full bg-foreground/20 motion-safe:animate-pulse" />
        </div>
      </div>
    </div>
  );
}
