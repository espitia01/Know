"use client";

import { useEffect, useRef } from "react";

interface UpgradeScheduledModalProps {
  tierLabel: string;
  /** Unix timestamp (seconds) when the new tier becomes active. */
  effectiveAt: number | null;
  open: boolean;
  onClose: () => void;
}

function formatDate(ts: number | null) {
  if (!ts) return "your next renewal";
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "your next renewal";
  }
}

export function UpgradeScheduledModal({ tierLabel, effectiveAt, open, onClose }: UpgradeScheduledModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const date = formatDate(effectiveAt);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Upgrade to ${tierLabel} scheduled`}
    >
      <div className="absolute inset-0 bg-foreground/25 backdrop-blur-md" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative glass-strong rounded-2xl shadow-xl max-w-md w-full mx-4 overflow-hidden animate-fade-in"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground z-10 ring-focus"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="glass-subtle px-6 pt-8 pb-5 text-center border-b border-border">
          <div className="w-12 h-12 rounded-xl glass flex items-center justify-center mx-auto mb-4 shadow-sm">
            <svg className="w-6 h-6 text-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="font-display text-[19px] font-bold tracking-[-0.02em] text-foreground">Upgrade scheduled</h2>
          <p className="text-[13px] text-muted-foreground mt-1.5">
            You&apos;ll move to {tierLabel} on {date}.
          </p>
        </div>

        <div className="px-6 py-5 space-y-3 text-[12.5px] text-muted-foreground">
          <p>
            Your current plan continues with no interruption, and no charge is
            applied today. On your next renewal date you&apos;ll be billed the
            standard {tierLabel} rate and unlock every feature automatically.
          </p>
          <p className="text-muted-foreground/80">
            Changed your mind? Cancel or modify the scheduled change anytime
            from the billing portal.
          </p>
        </div>

        <div className="px-6 pb-6">
          <button
            onClick={onClose}
            className="w-full text-[13px] font-semibold py-3 rounded-xl btn-primary-glass"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
