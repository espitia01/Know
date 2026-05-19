"use client";

import { ModelPill } from "@/components/analysis/ModelPill";
import { OverflowMenu } from "@/components/analysis/OverflowMenu";
import { modelLabel } from "@/lib/modelLabels";
import { cn } from "@/lib/utils";

export function ModelOverridePill({
  model,
  allowed,
  onChange,
}: {
  model: string;
  allowed: string[];
  onChange: (slug: string) => void;
}) {
  const options = allowed.length > 0 ? allowed : [model];

  return (
    <OverflowMenu
      ariaLabel="Model for this follow-up"
      buttonProps={{
        className:
          "rounded-full border border-border/55 bg-muted/30 px-1.5 py-0.5 text-foreground/80 hover:bg-accent/50 motion-safe:duration-150",
        title: "Choose model for this follow-up only",
        "aria-label": "Choose model for this follow-up",
      }}
      triggerInner={<ModelPill slug={model} className="border-0 bg-transparent px-0" />}
    >
      <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
        Model (this message)
      </div>
      {options.map((slug) => {
        const { short, tone } = modelLabel(slug);
        const active = slug === model;
        return (
          <button
            key={slug}
            type="button"
            onClick={() => onChange(slug)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-sm)] hover:bg-accent motion-safe:duration-150",
              active && "bg-accent/50",
            )}
            data-action={tone === "amber" ? "assumptions" : tone === "violet" ? "derive" : "explain"}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: "rgb(var(--highlight-rgb) / 0.85)" }}
            />
            <span className="text-foreground/90">{short}</span>
          </button>
        );
      })}
    </OverflowMenu>
  );
}
