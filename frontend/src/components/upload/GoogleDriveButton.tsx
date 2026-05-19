"use client";

import { useCallback, useEffect, useState } from "react";

import {
  GoogleDriveCancelledError,
  GoogleDrivePopupBlockedError,
  isGoogleDriveConfigured,
  pickAndDownloadDriveFile,
  preloadGoogleDrive,
} from "@/lib/googleDrive";
import { cn } from "@/lib/utils";

interface GoogleDriveButtonProps {
  /** Called with the downloaded PDF. Caller handles the actual upload. */
  onFile: (file: File) => void | Promise<void>;
  /** Disable while a parent flow is busy (e.g. uploading). */
  disabled?: boolean;
  /** Max bytes accepted from Drive — keeps parity with multipart upload. */
  maxBytes?: number;
  /** "primary" matches the upload CTA; "secondary" sits under it. */
  variant?: "primary" | "secondary";
  /** Optional className passthrough so the button can match parent chrome. */
  className?: string;
  /** Optional onError so the caller can surface the message inline. */
  onError?: (message: string) => void;
}

/**
 * Renders nothing when Google Drive env vars are absent — keeps the
 * feature behind a soft flag so previews and CI without Google creds
 * don't show a button that can't possibly work.
 */
export function GoogleDriveButton({
  onFile,
  disabled,
  maxBytes,
  variant = "secondary",
  className,
  onError,
}: GoogleDriveButtonProps) {
  const [busy, setBusy] = useState(false);
  const [popupHint, setPopupHint] = useState(false);

  // Pre-load Google's SDKs the moment the button mounts. Browsers
  // (especially Safari/Firefox) only allow popups inside the same tick
  // as a user gesture; if the click handler had to await a script
  // load, the popup would be flagged as programmatic and blocked.
  useEffect(() => {
    preloadGoogleDrive();
  }, []);

  const handleClick = useCallback(async () => {
    if (busy || disabled) return;
    setBusy(true);
    setPopupHint(false);
    try {
      const file = await pickAndDownloadDriveFile({ maxBytes });
      if (!file) return;
      await onFile(file);
    } catch (e) {
      if (e instanceof GoogleDriveCancelledError) {
        return;
      }
      if (e instanceof GoogleDrivePopupBlockedError) {
        setPopupHint(true);
        onError?.(
          "Your browser blocked the Google sign-in popup. Click the button again to retry, or allow pop-ups for this site.",
        );
        return;
      }
      const message =
        e instanceof Error ? e.message : "Google Drive import failed.";
      if (onError) onError(message);
      else console.error("[GoogleDriveButton]", message);
    } finally {
      setBusy(false);
    }
  }, [busy, disabled, maxBytes, onFile, onError]);

  if (!isGoogleDriveConfigured()) return null;

  const isPrimary = variant === "primary";

  return (
    <div className="w-full space-y-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || disabled}
        aria-busy={busy}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[12px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
          isPrimary
            ? "btn-primary-glass text-background"
            : "border border-border/65 bg-background/70 text-foreground/90 hover:border-border-strong hover:bg-accent/40",
          className,
        )}
      >
        {busy ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
            Connecting to Drive…
          </>
        ) : (
          <>
            <GoogleDriveIcon className="h-3.5 w-3.5" />
            {popupHint ? "Retry — click to allow popup" : "Open from Google Drive"}
          </>
        )}
      </button>
      {popupHint && !busy && (
        <p
          role="status"
          className="text-[11px] leading-snug text-muted-foreground/85"
        >
          Your browser blocked the Google sign-in popup. Click the button again
          to retry, or allow pop-ups for this site in your browser settings.
        </p>
      )}
    </div>
  );
}

function GoogleDriveIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 87.3 78"
      aria-hidden
      focusable="false"
    >
      <path
        d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
        fill="#0066da"
      />
      <path
        d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
        fill="#ea4335"
      />
      <path
        d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
        fill="#00832d"
      />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  );
}
