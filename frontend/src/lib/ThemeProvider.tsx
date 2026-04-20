"use client";

/**
 * Lightweight theme provider.
 *
 * - `theme` is one of "light" | "dark" | "system". We persist the user's
 *   choice in localStorage so it survives reloads and cross-tab toggles,
 *   and listen to `prefers-color-scheme` so "system" updates live.
 * - We do NOT render anything server-side that depends on theme; the
 *   actual `.dark` class is applied by the inline `<script>` in
 *   `layout.tsx` BEFORE first paint to avoid a white flash in dark mode.
 *   This provider just keeps the class in sync for subsequent changes.
 * - The toggle UI reads `theme` (the user's stored preference), not the
 *   effective `resolvedTheme`, so the three-state cycle is predictable.
 */

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

const STORAGE_KEY = "know:theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeClass(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // Keep the mobile browser chrome color in sync so the PWA looks right.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = resolved === "dark" ? "#16181f" : "#fbfbfb";
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  // Hydrate from localStorage once, then compute the effective mode.
  useEffect(() => {
    let stored: ThemeMode = "system";
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      // Ignore storage errors (private mode, quota, etc.) — fall back to system.
    }
    setThemeState(stored);
    const effective = stored === "system" ? getSystemTheme() : stored;
    setResolvedTheme(effective);
    applyThemeClass(effective);
  }, []);

  // Live-update when the OS theme changes and the user is on "system".
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

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      if (e.newValue === "light" || e.newValue === "dark" || e.newValue === "system") {
        setThemeState(e.newValue);
        const eff = e.newValue === "system" ? getSystemTheme() : e.newValue;
        setResolvedTheme(eff);
        applyThemeClass(eff);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((t: ThemeMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
    setThemeState(t);
    const eff = t === "system" ? getSystemTheme() : t;
    setResolvedTheme(eff);
    applyThemeClass(eff);
  }, []);

  const toggleTheme = useCallback(() => {
    // Three-state cycle: system → light → dark → system.
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
    // Safe fallback so components using useTheme outside the provider
    // (e.g. in tests) don't crash.
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
 * Inline script evaluated BEFORE React hydrates. Sets the correct `.dark`
 * class and meta theme-color so the page doesn't flash white when a
 * dark-mode user lands on it.
 *
 * Kept tiny and defensive — any throw here would block rendering.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var k = "${STORAGE_KEY}";
    var m = localStorage.getItem(k);
    var sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var t = (m === "light" || m === "dark") ? m : sys;
    if (t === "dark") document.documentElement.classList.add("dark");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "dark" ? "#16181f" : "#fbfbfb");
  } catch (e) { /* no-op */ }
})();
`.trim();
