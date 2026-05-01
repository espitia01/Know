"use client";

/**
 * Lightweight theme provider.
 *
 * - `theme` is one of "light" | "dark" | "system". We persist the user's
 *   choice in localStorage (per Clerk userId) so it survives reloads and
 *   cross-tab toggles, and listen to `prefers-color-scheme` so "system"
 *   updates live.
 * - An inline script in `layout.tsx` reads a mirrored cookie plus any
 *   `know:theme:v2:*` localStorage entry before React runs so the first
 *   paint matches the user's pinned light/dark preference (not a brief
 *   system-theme flash). This provider then reconciles after Clerk loads.
 * - The toggle UI reads `theme` (the user's stored preference), not the
 *   effective `resolvedTheme`, so the three-state cycle is predictable.
 */

import { useAuth } from "@clerk/nextjs";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
}

/** @deprecated Global theme key — removed from reads to avoid cross-account bleed. */
export const LEGACY_THEME_STORAGE_KEY = "know:theme";

export function themeStorageKey(userId: string | null): string {
  return userId ? `know:theme:v2:${userId}` : `know:theme:v2:signed-out`;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readDomResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeClass(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = resolved === "dark" ? "#16181f" : "#fbfbfb";
  }
}

/** Cookie mirrored from this provider so the bootstrap script can resolve
 *  theme before React without waiting on Clerk. */
export const THEME_PREFERENCE_COOKIE = "know_theme";

export function syncThemePreferenceCookie(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${THEME_PREFERENCE_COOKIE}=${encodeURIComponent(mode)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // ignore
  }
}

/**
 * Inline script evaluated BEFORE React hydrates. Order: preference cookie →
 * any stored `know:theme:v2:*` value → legacy `know:theme` → system.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    function getCookie(name) {
      var parts = ("; " + document.cookie).split("; " + name + "=");
      if (parts.length < 2) return "";
      return decodeURIComponent(parts.pop().split(";").shift() || "");
    }
    function readPref() {
      var c = getCookie("${THEME_PREFERENCE_COOKIE}");
      if (c === "light" || c === "dark" || c === "system") return c;
      try {
        var i, k, v;
        for (i = 0; i < localStorage.length; i++) {
          k = localStorage.key(i);
          if (k && k.indexOf("know:theme:v2:") === 0) {
            v = localStorage.getItem(k);
            if (v === "light" || v === "dark" || v === "system") return v;
          }
        }
        v = localStorage.getItem("${LEGACY_THEME_STORAGE_KEY}");
        if (v === "light" || v === "dark") return v;
      } catch (e0) { /* no-op */ }
      return "system";
    }
    function resolve(p) {
      if (p === "light" || p === "dark") return p;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var resolved = resolve(readPref());
    document.documentElement.classList.toggle("dark", resolved === "dark");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#16181f" : "#fbfbfb");
  } catch (e) { /* no-op */ }
})();
`.trim();

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const [theme, setThemeState] = useState<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(readDomResolvedTheme);

  const storageKey = useMemo(() => themeStorageKey(userId ?? null), [userId]);

  useEffect(() => {
    if (!isLoaded) return;
    let stored: ThemeMode = "system";
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      // Ignore storage errors (private mode, quota, etc.) — fall back to system.
    }
    setThemeState(stored);
    syncThemePreferenceCookie(stored);
    const effective = stored === "system" ? getSystemTheme() : stored;
    setResolvedTheme(effective);
    applyThemeClass(effective);
  }, [isLoaded, storageKey]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const sys = mq.matches ? "dark" : "light";
      setResolvedTheme(sys);
      applyThemeClass(sys);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey || !e.newValue) return;
      if (e.newValue === "light" || e.newValue === "dark" || e.newValue === "system") {
        syncThemePreferenceCookie(e.newValue);
        setThemeState(e.newValue);
        const eff = e.newValue === "system" ? getSystemTheme() : e.newValue;
        setResolvedTheme(eff);
        applyThemeClass(eff);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const setTheme = useCallback(
    (t: ThemeMode) => {
      if (!isLoaded) return;
      try {
        localStorage.setItem(storageKey, t);
        localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
      } catch {
        // ignore
      }
      syncThemePreferenceCookie(t);
      setThemeState(t);
      const eff = t === "system" ? getSystemTheme() : t;
      setResolvedTheme(eff);
      applyThemeClass(eff);
    },
    [isLoaded, storageKey],
  );

  const toggleTheme = useCallback(() => {
    setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system");
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return {
      theme: "system",
      resolvedTheme: "light",
      setTheme: () => {},
      toggleTheme: () => {},
    };
  }
  return ctx;
}
