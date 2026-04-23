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
        // Match ThemeToggle's visual weight: hairline-bordered glass pill
        // so the button reads as a peer control instead of a muted
        // afterthought. Previously it was nearly invisible over the mesh
        // background on light mode.
        "h-8 w-8 flex items-center justify-center rounded-lg " +
        "border border-border/80 bg-background/60 backdrop-blur-md " +
        "text-foreground/80 hover:text-foreground hover:bg-accent " +
        "transition-colors ring-focus " +
        className
      }
      title={isFullscreen ? "Exit fullscreen (Esc)" : "Enter fullscreen"}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      aria-pressed={isFullscreen}
    >
      {isFullscreen ? (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M15 9V4.5M15 9h4.5M9 15v4.5M9 15H4.5M15 15v4.5M15 15h4.5" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 8.25V4.5h3.75M19.5 8.25V4.5h-3.75M4.5 15.75v3.75h3.75M19.5 15.75v3.75h-3.75" />
        </svg>
      )}
    </button>
  );
}
