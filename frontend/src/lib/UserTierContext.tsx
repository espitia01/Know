"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode, useMemo } from "react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/lib/api";

const CANCELLATION_DISMISS_KEY = "know-cancel-banner-dismissed";

export interface UserInfo {
  user_id: string;
  tier: "free" | "scholar" | "researcher";
  paper_count: number;
  has_billing: boolean;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
}

interface UserTierContextValue {
  user: UserInfo | null;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

const UserTierContext = createContext<UserTierContextValue>({
  user: null,
  loading: true,
  error: false,
  refresh: async () => {},
});

export function UserTierProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setUser(null);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const data = await api.getCurrentUser();
      const tier = data.tier;
      const safeTier = (tier === "free" || tier === "scholar" || tier === "researcher") ? tier : "free";
      setUser({ ...data, tier: safeTier } as UserInfo);
    } catch {
      setUser(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [isSignedIn, isLoaded]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-pull the tier whenever the tab regains focus or comes back from
  // hidden. Webhooks update the tier server-side asynchronously (Stripe can
  // take a few seconds), and users who open the app in one tab while
  // subscribing in another tab would otherwise see a stale "free" tier
  // until a manual reload. This also covers the period-end downgrade case
  // where someone left the tab open overnight.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  return (
    <UserTierContext.Provider value={{ user, loading, error, refresh }}>
      {children}
      <CancellationBanner user={user} />
      {/* Surface tier-fetch failures instead of silently defaulting to
          "free" — otherwise paying users see unexplained downgrade UX
          while the real problem is a network/auth blip they can retry. */}
      {error && isSignedIn && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-[200] max-w-sm glass-strong border border-destructive/30/70 rounded-xl px-4 py-3 shadow-lg"
        >
          <p className="text-[12px] font-semibold text-destructive">
            Couldn&apos;t load your account
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Some features may be temporarily unavailable.
          </p>
          <button
            onClick={() => { void refresh(); }}
            className="mt-2 text-[11px] font-medium text-foreground/90 hover:text-foreground underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}
    </UserTierContext.Provider>
  );
}

export function useUserTier() {
  return useContext(UserTierContext);
}

// Single banner displayed app-wide (Settings still shows its detailed
// cancellation card). Users previously only learned their subscription was
// cancelled when they happened to visit Settings; now they're reminded
// wherever they are.
function CancellationBanner({ user }: { user: UserInfo | null }) {
  const [dismissed, setDismissed] = useState(true);
  const cancelAt = user?.cancel_at ?? null;

  useEffect(() => {
    if (!user?.cancel_at_period_end) { setDismissed(true); return; }
    if (typeof window === "undefined") return;
    try {
      const stored = sessionStorage.getItem(CANCELLATION_DISMISS_KEY);
      setDismissed(stored === String(cancelAt));
    } catch {
      setDismissed(false);
    }
  }, [user?.cancel_at_period_end, cancelAt]);

  const dateLabel = useMemo(() => {
    if (!cancelAt) return "";
    try {
      return new Date(cancelAt * 1000).toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric",
      });
    } catch { return ""; }
  }, [cancelAt]);

  if (!user?.cancel_at_period_end || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[150] max-w-md w-[calc(100vw-2rem)] glass-strong border border-amber-200/70 rounded-xl px-4 py-3 shadow-lg flex items-start gap-3"
    >
      <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-foreground">
          Subscription ending{dateLabel ? ` on ${dateLabel}` : ""}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          You&apos;ll keep access until then. Visit Settings to resume.
        </p>
      </div>
      <button
        onClick={() => {
          setDismissed(true);
          if (typeof window !== "undefined") {
            try { sessionStorage.setItem(CANCELLATION_DISMISS_KEY, String(cancelAt ?? "")); } catch { /* ignore */ }
          }
        }}
        aria-label="Dismiss"
        className="text-muted-foreground/80 hover:text-muted-foreground transition-colors shrink-0"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export const TIER_FEATURES: Record<string, Set<string>> = {
  free: new Set(["summary", "qa", "selection"]),
  scholar: new Set(["summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex"]),
  researcher: new Set(["summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "bibtex", "multi-qa"]),
};

export function canAccess(tier: string, feature: string): boolean {
  return (TIER_FEATURES[tier] || TIER_FEATURES.free).has(feature);
}
