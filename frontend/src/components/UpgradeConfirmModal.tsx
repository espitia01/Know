"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

type Preview = {
  currency: string;
  immediate_charge_cents: number;
  next_cycle_charge_cents: number;
  period_end: number | null;
  current_tier: string;
  target_tier: string;
};

interface UpgradeConfirmModalProps {
  /** Target tier to upgrade to (e.g. "researcher"). */
  tier: "scholar" | "researcher";
  /** Human-readable tier label shown in the header. */
  tierLabel: string;
  open: boolean;
  onClose: () => void;
  /**
   * Called after a successful upgrade with the mode the user picked.
   * ``"now"`` means the tier flipped immediately; ``"next_cycle"`` means
   * the change was scheduled for their next renewal. The parent is
   * responsible for refreshing the tier context and surfacing the
   * appropriate post-upgrade experience (e.g. the welcome modal for
   * immediate upgrades, or a "scheduled" toast for deferred ones).
   */
  onUpgraded: (mode: "now" | "next_cycle", preview: Preview | null) => void;
}

function formatCurrency(cents: number, currency: string) {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function formatDate(ts: number | null) {
  if (!ts) return "your next billing date";
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "your next billing date";
  }
}

export function UpgradeConfirmModal({ tier, tierLabel, open, onClose, onUpgraded }: UpgradeConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState<null | "now" | "next_cycle">(null);

  // Fetch the proration preview when the modal opens. We deliberately
  // keep this inside the modal (rather than pre-fetching on mount of
  // the parent page) so the preview always reflects the very latest
  // subscription state — the user may have cancelled + resumed in
  // another tab since they opened Settings.
  useEffect(() => {
    if (!open) return;
    setError("");
    setPreview(null);
    setLoadingPreview(true);
    let cancelled = false;
    api.previewUpgrade(tier)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Could not load pricing preview.";
        setError(msg);
      })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [open, tier]);

  // Escape-to-close parity with the rest of our modals.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !submitting) onClose(); };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, submitting]);

  const dateLabel = useMemo(() => formatDate(preview?.period_end ?? null), [preview?.period_end]);

  const submit = async (when: "now" | "next_cycle") => {
    setSubmitting(when);
    setError("");
    try {
      await api.upgradeSubscription(tier, when);
      onUpgraded(when, preview);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upgrade failed. Please try again.";
      setError(msg);
    } finally {
      setSubmitting(null);
    }
  };

  if (!open) return null;

  const currency = preview?.currency || "usd";
  const immediate = preview ? formatCurrency(preview.immediate_charge_cents, currency) : "—";
  const nextCycle = preview ? formatCurrency(preview.next_cycle_charge_cents, currency) : "—";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Upgrade to ${tierLabel}`}
    >
      <div
        className="absolute inset-0 bg-foreground/25 backdrop-blur-md"
        onClick={() => { if (!submitting) onClose(); }}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative glass-strong rounded-2xl shadow-xl max-w-md w-full mx-4 overflow-hidden animate-fade-in"
      >
        <button
          onClick={onClose}
          disabled={submitting !== null}
          aria-label="Close"
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-accent transition-colors text-muted-foreground hover:text-foreground z-10 ring-focus disabled:opacity-40"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="px-6 pt-7 pb-3">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground/80">
            Confirm upgrade
          </p>
          <h2 className="font-display text-[19px] font-bold tracking-[-0.02em] text-foreground mt-1">
            Upgrade to {tierLabel}
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-1.5">
            Choose when you&apos;d like the change to take effect.
          </p>
        </div>

        <div className="px-6 pb-5 space-y-2.5">
          {/* Option 1 — upgrade now, prorated. */}
          <div className="rounded-xl border border-border/80 glass-subtle p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-foreground">Upgrade now</p>
                <p className="text-[11.5px] text-muted-foreground mt-0.5">
                  Switch to {tierLabel} immediately. You&apos;ll be charged the
                  prorated difference for the remainder of this billing cycle.
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold">Today</p>
                <p className="text-[15px] font-semibold tabular-nums text-foreground">
                  {loadingPreview ? (
                    <span className="inline-block w-12 h-4 rounded bg-muted animate-pulse align-middle" />
                  ) : immediate}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => submit("now")}
              disabled={submitting !== null || loadingPreview || !preview}
              className="mt-3 w-full text-[13px] font-semibold py-2.5 rounded-xl bg-foreground text-background shadow-sm hover:opacity-95 transition-opacity disabled:opacity-50"
            >
              {submitting === "now" ? "Upgrading…" : `Upgrade now · ${loadingPreview ? "…" : immediate}`}
            </button>
          </div>

          {/* Option 2 — defer to next renewal. */}
          <div className="rounded-xl border border-border/70 glass-subtle p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-foreground">Start next cycle</p>
                <p className="text-[11.5px] text-muted-foreground mt-0.5">
                  Keep your current plan through {dateLabel}. {tierLabel} takes
                  effect automatically on renewal with no extra charge today.
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80 font-semibold">On {preview?.period_end ? "renewal" : "next cycle"}</p>
                <p className="text-[15px] font-semibold tabular-nums text-foreground">
                  {loadingPreview ? (
                    <span className="inline-block w-12 h-4 rounded bg-muted animate-pulse align-middle" />
                  ) : nextCycle}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => submit("next_cycle")}
              disabled={submitting !== null || loadingPreview || !preview}
              className="mt-3 w-full text-[13px] font-semibold py-2.5 rounded-xl border border-border bg-background/60 hover:bg-accent text-foreground transition-colors disabled:opacity-50"
            >
              {submitting === "next_cycle" ? "Scheduling…" : "Schedule for next cycle"}
            </button>
          </div>

          {error && (
            <p className="text-[12px] text-destructive text-center pt-1">{error}</p>
          )}
          <p className="text-[11px] text-muted-foreground/80 text-center pt-1">
            You can manage or cancel your plan anytime from the billing portal.
          </p>
        </div>
      </div>
    </div>
  );
}
