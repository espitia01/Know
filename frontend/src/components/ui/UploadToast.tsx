"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { OwlSpinner } from "@/components/ui/OwlSpinner";

/**
 * Floating toast that surfaces the in-flight upload queue even when the
 * upload popover has closed — so a user who picks files and walks away
 * still sees "Uploading 2 papers…" until the parses finish.
 */
export function UploadToast() {
  const uploads = useStore((s) => s.uploads);
  const dismissUpload = useStore((s) => s.dismissUpload);
  const clearFinishedUploads = useStore((s) => s.clearFinishedUploads);

  const uploading = uploads.filter((u) => u.status === "uploading");
  const finished = uploads.filter((u) => u.status !== "uploading");
  const failures = finished.filter((u) => u.status === "failed");

  // Auto-dismiss the toast 5s after all uploads finish successfully.
  useEffect(() => {
    if (uploading.length > 0) return;
    if (finished.length === 0) return;
    if (failures.length > 0) return; // keep failures visible
    const id = setTimeout(() => clearFinishedUploads(), 5_000);
    return () => clearTimeout(id);
  }, [uploading.length, finished.length, failures.length, clearFinishedUploads]);

  if (uploads.length === 0) return null;

  const lead =
    uploading.length > 0
      ? `Uploading ${uploading.length} paper${uploading.length === 1 ? "" : "s"}…`
      : failures.length > 0
        ? `${failures.length} upload${failures.length === 1 ? "" : "s"} failed`
        : `Uploaded ${finished.length} paper${finished.length === 1 ? "" : "s"}`;

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[200] flex max-w-[22rem] flex-col gap-2 motion-safe:animate-fade-in">
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border/50 bg-background shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-3 border-b border-border/40 px-4 py-3">
          <div className="text-foreground/80">
            {uploading.length > 0 ? (
              <OwlSpinner size={20} label={lead} />
            ) : failures.length > 0 ? (
              <svg
                className="h-5 w-5 text-destructive"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.008v.008H12v-.008z"
                />
              </svg>
            ) : (
              <svg
                className="h-5 w-5 text-foreground/80"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-foreground">{lead}</p>
            {uploading.length > 0 && finished.length > 0 && (
              <p className="text-[11px] text-muted-foreground/85">
                {finished.length} ready · {uploading.length} in flight
              </p>
            )}
          </div>
          {uploading.length === 0 && (
            <button
              type="button"
              onClick={clearFinishedUploads}
              className="rounded-md p-1 text-muted-foreground/70 hover:bg-accent/40 hover:text-foreground"
              aria-label="Dismiss"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path d="M6.28 5.22a.75.75 0 011.06 0L10 7.88l2.66-2.66a.75.75 0 111.06 1.06L11.06 8.94l2.66 2.66a.75.75 0 11-1.06 1.06L10 10l-2.66 2.66a.75.75 0 11-1.06-1.06l2.66-2.66-2.66-2.66a.75.75 0 010-1.06z" />
              </svg>
            </button>
          )}
        </div>
        <ul className="max-h-48 overflow-y-auto divide-y divide-border/30">
          {uploads.slice(-6).map((u) => (
            <li
              key={u.id}
              className="flex items-center gap-2 px-4 py-2 text-[12px]"
              title={u.error || u.filename}
            >
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/30" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground/85">{u.filename}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                {u.status === "uploading"
                  ? "Uploading"
                  : u.status === "succeeded"
                    ? "Ready"
                    : "Failed"}
              </span>
              {u.status !== "uploading" && (
                <button
                  type="button"
                  onClick={() => dismissUpload(u.id)}
                  className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground"
                  aria-label="Remove"
                >
                  <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path d="M6.28 5.22a.75.75 0 011.06 0L10 7.88l2.66-2.66a.75.75 0 111.06 1.06L11.06 8.94l2.66 2.66a.75.75 0 11-1.06 1.06L10 10l-2.66 2.66a.75.75 0 11-1.06-1.06l2.66-2.66-2.66-2.66a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
