"use client";

import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  body,
  cta,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  cta?: {
    label: string;
    onClick: () => void;
    loading?: boolean;
  };
}) {
  return (
    <div className="py-8 text-center space-y-4 animate-fade-in">
      {icon && (
        <div className="w-10 h-10 mx-auto rounded-xl glass-subtle flex items-center justify-center text-muted-foreground/50">
          {icon}
        </div>
      )}
      <div className="space-y-1.5">
        <p className="text-[var(--text-md)] font-medium text-foreground">{title}</p>
        {body && (
          <p className="text-[var(--text-sm)] text-muted-foreground max-w-sm mx-auto leading-relaxed">
            {body}
          </p>
        )}
      </div>
      {cta && (
        <button
          onClick={cta.onClick}
          disabled={cta.loading}
          className="text-[var(--text-sm)] font-medium bg-foreground text-background px-4 py-2 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {cta.loading ? "Working..." : cta.label}
        </button>
      )}
    </div>
  );
}
