"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/lib/api";

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

  return (
    <UserTierContext.Provider value={{ user, loading, error, refresh }}>
      {children}
    </UserTierContext.Provider>
  );
}

export function useUserTier() {
  return useContext(UserTierContext);
}

export const TIER_FEATURES: Record<string, Set<string>> = {
  free: new Set(["summary", "qa", "selection"]),
  scholar: new Set(["summary", "prepare", "assumptions", "qa", "figures", "notes", "selection"]),
  researcher: new Set(["summary", "prepare", "assumptions", "qa", "figures", "notes", "selection", "multi-qa"]),
};

export function canAccess(tier: string, feature: string): boolean {
  return (TIER_FEATURES[tier] || TIER_FEATURES.free).has(feature);
}
