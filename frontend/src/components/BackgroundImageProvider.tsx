"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import {
  applyBackgroundState,
  backgroundStorageKey,
  readBackgroundCache,
} from "@/lib/backgroundImage";
import { useTheme } from "@/lib/ThemeProvider";

/**
 * Reads the signed-in user's saved background from localStorage on the
 * client and applies it to the document root. Listens for storage events
 * so a change made in another tab propagates live. Re-applies when the
 * color scheme changes so light/dark preset variants stay in sync.
 */
export function BackgroundImageProvider() {
  const { isLoaded, userId } = useAuth();
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!isLoaded) return;
    applyBackgroundState(readBackgroundCache(userId ?? null), resolvedTheme === "dark");
  }, [isLoaded, userId, resolvedTheme]);

  useEffect(() => {
    if (!isLoaded || !userId) return;

    const key = backgroundStorageKey(userId);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      applyBackgroundState(readBackgroundCache(userId), resolvedTheme === "dark");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [isLoaded, userId, resolvedTheme]);

  return null;
}
