"use client";

import type { ReactNode } from "react";
import { ModelPill } from "@/components/analysis/ModelPill";
import { relativeTime } from "@/lib/time";

export function CardMeta({
  model,
  createdAt,
  extra,
}: {
  model?: string | null;
  createdAt?: number | string | null;
  extra?: ReactNode;
}) {
  const rel = relativeTime(createdAt);
  if (!model && !rel && !extra) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[var(--text-xs)] text-muted-foreground/85">
      <ModelPill slug={model} />
      {rel && (
        <span
          title={
            typeof createdAt === "number"
              ? new Date(createdAt).toLocaleString()
              : String(createdAt)
          }
        >
          {rel}
        </span>
      )}
      {extra}
    </div>
  );
}
