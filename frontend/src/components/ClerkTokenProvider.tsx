"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { setClerkTokenGetter } from "@/lib/api";
import { UserTierProvider } from "@/lib/UserTierContext";

export function ClerkTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();

  useEffect(() => {
    setClerkTokenGetter(getToken);
  }, [getToken]);

  return <UserTierProvider>{children}</UserTierProvider>;
}
