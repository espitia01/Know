"use client";

/**
 * Compact three-state theme switcher. Cycles System → Light → Dark → …
 *
 * The button renders a sun, a moon, or a monitor glyph based on the
 * user's CURRENT preference (not the resolved theme) — this way a user
 * on "system" can see at a glance that they're on auto, not that "dark"
 * is pinned.
 */

import { useTheme } from "@/lib/ThemeProvider";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
  /** Show a text label next to the icon (for settings menus). */
  showLabel?: boolean;
}

export function ThemeToggle({ className, showLabel }: Props) {
  const { theme, toggleTheme } = useTheme();

  const label =
    theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";

  const title = `Theme: ${label} (click to switch)`;

  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      onClick={toggleTheme}
      className={cn(
        "inline-flex items-center gap-2 h-8 px-2.5 rounded-lg",
        "text-[13px] font-medium text-muted-foreground",
        "border border-border/70 bg-background/60",
        "hover:text-foreground hover:bg-accent hover:border-border-strong",
        "transition-colors ring-focus",
        showLabel ? "min-w-[90px] justify-start" : "w-8 justify-center p-0",
        className,
      )}
    >
      {theme === "light" ? (
        <SunIcon />
      ) : theme === "dark" ? (
        <MoonIcon />
      ) : (
        <SystemIcon />
      )}
      {showLabel && <span>{label}</span>}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
