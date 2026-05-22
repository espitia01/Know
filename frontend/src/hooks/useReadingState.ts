"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";

const DEBOUNCE_MS = 1500;

type Patch = {
  last_page?: number;
  last_tab?: string | null;
  scroll_pct?: number | null;
};

/**
 * Debounced writer for `paper_reading_state`. The hook keeps the latest
 * pending patch per paper and flushes either on the debounce timer or via
 * `sendBeacon` when the page is unloading.
 *
 * The signature is intentionally `saveProgress(patch)` — a callback that
 * never resolves so callers can call it in render-adjacent paths (PdfViewer
 * scroll handlers) without awaiting.
 */
export function useReadingState(paperId: string | null | undefined): {
  saveProgress: (patch: Patch) => void;
} {
  const pendingRef = useRef<Patch | null>(null);
  const lastSentRef = useRef<Patch>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paperIdRef = useRef<string | null>(paperId ?? null);
  paperIdRef.current = paperId ?? null;

  const flush = useCallback(async () => {
    timerRef.current = null;
    const pid = paperIdRef.current;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pid || !pending) return;
    // Drop fields that match the most recent confirmed write so we don't
    // bounce the API on a slow steady-state scroll.
    const merged: Patch = {};
    for (const key of Object.keys(pending) as (keyof Patch)[]) {
      const next = pending[key];
      if (next === undefined) continue;
      if (lastSentRef.current[key] === next) continue;
      merged[key] = next as never;
    }
    if (Object.keys(merged).length === 0) return;
    try {
      const row = await api.putReadingState(pid, merged);
      lastSentRef.current = { ...lastSentRef.current, ...merged };
      useStore.getState().setReadingStateForPaper(pid, {
        last_page: row.last_page,
        last_tab: row.last_tab,
        scroll_pct: row.scroll_pct,
      });
    } catch {
      // Best-effort; reading state restores defaults on next paper open.
    }
  }, []);

  const saveProgress = useCallback((patch: Patch) => {
    pendingRef.current = { ...(pendingRef.current ?? {}), ...patch };
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => {
    const onUnload = () => {
      const pid = paperIdRef.current;
      const pending = pendingRef.current;
      if (!pid || !pending) return;
      try {
        const url = `/api/papers/${pid}/reading-state`;
        const blob = new Blob([JSON.stringify(pending)], { type: "application/json" });
        // sendBeacon is fire-and-forget but cannot attach auth headers. For
        // signed-in browsers the Clerk session cookie travels along, which
        // is enough for the same-origin Vercel deploy. On the Railway
        // standalone backend we'd need a different path; until then this is
        // a best-effort tail-of-session flush.
        if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
          navigator.sendBeacon(url, blob);
        }
      } catch {
        /* best-effort */
      }
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        void flush();
      }
    };
  }, [flush]);

  // Drop any pending patch when the paper id changes — the new paper has its
  // own reading state and we don't want to stamp the previous paper's row
  // with the wrong page.
  useEffect(() => {
    pendingRef.current = null;
    lastSentRef.current = {};
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [paperId]);

  return { saveProgress };
}
