"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { setClerkTokenGetter } from "@/lib/api";
import { UserTierProvider } from "@/lib/UserTierContext";

export function ClerkTokenProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    const getter = async () => {
      const token = await getToken();
      if (!token && isSignedIn) {
        console.warn("[Know] Clerk getToken() returned null while signed in");
      }
      return token;
    };
    setClerkTokenGetter(getter);
  }, [getToken, isSignedIn]);

  return <UserTierProvider>{children}</UserTierProvider>;
}
