"use client";

import { useCallback, useEffect, useState } from "react";

interface FullscreenToggleProps {
  className?: string;
  /**
   * Optional extra callback fired when the fullscreen state changes —
   * used by the reader to keep its internal `focusMode` store flag in
   * sync. The dashboard doesn't need this.
   */
  onChange?: (isFullscreen: boolean) => void;
}

/**
 * Small icon button that toggles the browser's native Fullscreen API
 * on `document.documentElement`. The browser's own Escape handling
 * exits fullscreen for us, but we still listen for `fullscreenchange`
 * so the button icon stays in sync if the user bails out via their
 * keyboard shortcut instead of clicking.
 *
 * Fullscreen can only be requested in response to a user gesture, which
 * is exactly the event we're handling, so there's no foot-gun here.
 * We still swallow the promise rejection because some browsers (Safari
 * in PWA mode, embedded webviews) throw "permission denied" — falling
 * back silently to a no-op is friendlier than surfacing a cryptic
 * error toast.
 */
export function FullscreenToggle({ className = "", onChange }: FullscreenToggleProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => {
      const active = !!document.fullscreenElement;
      setIsFullscreen(active);
      onChange?.(active);
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [onChange]);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => { /* ignore */ });
    } else {
      document.documentElement.requestFullscreen?.().catch(() => { /* ignore */ });
    }
  }, []);

  return (
    <button
      onClick={toggle}
      className={
        "text-muted-foreground/80 hover:text-foreground transition-colors " +
        "rounded-md p-1.5 ring-focus " +
        className
      }
      title={isFullscreen ? "Exit fullscreen (Esc)" : "Enter fullscreen"}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      aria-pressed={isFullscreen}
    >
      {isFullscreen ? (
        // Exit: arrows pointing inward
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9l-5.25-5.25M15 9V4.5M15 9h4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15v4.5M15 15h4.5M15 15l5.25 5.25" />
        </svg>
      ) : (
        // Enter: arrows pointing outward
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0l5.25 5.25M20.25 3.75h-4.5m4.5 0v4.5m0-4.5l-5.25 5.25M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0l5.25-5.25m10.5 5.25h-4.5m4.5 0v-4.5m0 4.5l-5.25-5.25" />
        </svg>
      )}
    </button>
  );
}
