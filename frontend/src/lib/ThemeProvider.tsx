"use client";

/**
 * Lightweight theme provider.
 *
 * - `theme` is one of "light" | "dark" | "system". We persist the user's
 *   choice in localStorage (per Clerk userId) so it survives reloads and
 *   cross-tab toggles, and listen to `prefers-color-scheme` so "system"
 *   updates live.
 * - The inline script in `layout.tsx` can only follow the OS preference
 *   before React + Clerk resolve the signed-in user; this provider then
 *   applies the stored per-account choice.
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

/**
 * Inline script evaluated BEFORE React hydrates. Uses OS color scheme only;
 * per-account theme is applied once Clerk + ThemeProvider load (localStorage
 * is scoped by userId and cannot be read safely here).
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    if (sys === "dark") document.documentElement.classList.add("dark");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", sys === "dark" ? "#16181f" : "#fbfbfb");
  } catch (e) { /* no-op */ }
})();
`.trim();
