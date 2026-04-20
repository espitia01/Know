"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { setClerkTokenGetter, clearAuthState } from "@/lib/api";
import { useStore } from "@/lib/store";
import { UserTierProvider } from "@/lib/UserTierContext";
import { ModelCapModal } from "@/components/ModelCapModal";

export function ClerkTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const prevSignedIn = useRef<boolean | null>(null);

  useEffect(() => {
    setClerkTokenGetter(getToken);
    return () => clearAuthState();
  }, [getToken]);

  // When Clerk reports a transition from signed-in → signed-out (including
  // sign-outs triggered from the Clerk <UserButton> menu, which bypasses our
  // explicit Settings button), wipe any lingering paper state + bearer token
  // so the next user can't inherit it from sessionStorage.
  useEffect(() => {
    if (!isLoaded) return;
    const wasSignedIn = prevSignedIn.current;
    prevSignedIn.current = !!isSignedIn;
    if (wasSignedIn === true && !isSignedIn) {
      try { useStore.getState().clearSession(); } catch { /* no-op */ }
      clearAuthState();
    }
  }, [isSignedIn, isLoaded]);

  return (
    <UserTierProvider>
      {children}
      <ModelCapModal />
    </UserTierProvider>
  );
}
