"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { setClerkTokenGetter, clearTokenRefreshInterval } from "@/lib/api";
import { UserTierProvider } from "@/lib/UserTierContext";
import { ModelCapModal } from "@/components/ModelCapModal";

export function ClerkTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();

  useEffect(() => {
    setClerkTokenGetter(getToken);
    return () => clearTokenRefreshInterval();
  }, [getToken]);

  return (
    <UserTierProvider>
      {children}
      <ModelCapModal />
    </UserTierProvider>
  );
}
