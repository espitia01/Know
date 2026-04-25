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
    <div className="space-y-4 py-10 text-center motion-safe:animate-fade-in">
      {icon && (
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border border-border/80 bg-card/20">
          <span className="text-muted-foreground/50 [&_svg]:size-5">{icon}</span>
        </div>
      )}
      <div className="space-y-1.5">
        <p className="text-[var(--text-md)] font-semibold text-foreground">
          {title}
        </p>
        {body && (
          <p className="mx-auto max-w-[42ch] text-[var(--text-sm)] text-muted-foreground leading-relaxed">
            {body}
          </p>
        )}
      </div>
      {(cta != null || secondaryAction != null) && (
        <div className="flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-3">
          {cta && (
            <button
              type="button"
              onClick={cta.onClick}
              disabled={cta.loading}
              className="btn-primary-glass rounded-lg px-4 py-2 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              {cta.loading ? "Working…" : cta.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
