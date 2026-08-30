"use client";

import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  body,
  cta,
  secondaryAction,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  cta?: {
    label: string;
    onClick: () => void;
    loading?: boolean;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
}) {
  return (
    <div className="space-y-3 py-8">
      {icon && (
        <div className="flex h-9 w-9 items-center justify-center text-muted-foreground/50 [&_svg]:size-4">
          {icon}
        </div>
      )}
      <div className="space-y-1.5">
        <p className="text-[var(--text-sm)] font-medium text-foreground">
          {title}
        </p>
        {body && (
          <p className="max-w-[46ch] text-[var(--text-sm)] text-muted-foreground leading-relaxed">
            {body}
          </p>
        )}
      </div>
      {(cta != null || secondaryAction != null) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {cta && (
            <button
              type="button"
              onClick={cta.onClick}
              disabled={cta.loading}
              className="rounded-md bg-primary px-3 py-1.5 text-[var(--text-sm)] font-medium text-primary-foreground motion-safe:duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              {cta.loading ? "Working…" : cta.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="text-[var(--text-sm)] font-medium text-muted-foreground motion-safe:duration-150 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
