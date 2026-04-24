"use client";

import { useEffect } from "react";
import { applyBackgroundState, loadBackgroundState } from "@/lib/backgroundImage";

/**
 * Reads the user's saved background preference from localStorage on
 * the client and applies it to the document root. Listens for
 * storage events so a change made in another tab (e.g. Settings
 * opened in a second window) propagates live to every mounted page.
 *
 * Deliberately headless — rendering null avoids hydration mismatches
 * and keeps the component cheap to mount from the root layout.
 */
export function BackgroundImageProvider() {
  useEffect(() => {
    applyBackgroundState(loadBackgroundState());

    const onStorage = (e: StorageEvent) => {
      if (e.key !== "know-bg-image") return;
      applyBackgroundState(loadBackgroundState());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return null;
}
