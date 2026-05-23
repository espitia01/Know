"use client";

import type { ReactNode } from "react";
import { OverflowMenu } from "@/components/analysis/OverflowMenu";
import { ExportsMenu } from "@/components/export/ExportsMenu";
import { FAMILY_TO_VAR } from "@/lib/analysisFont";
import type { AnalysisFontFamily } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { PanelPosition } from "./BottomPanel";

const POSITION_LABEL: Record<PanelPosition, string> = {
  right: "Right",
  bottom: "Bottom",
  left: "Left",
};

const positionIcons: Record<PanelPosition, { path: string; next: string }> = {
  right: { path: "M3 3h18v18H3V3zm12 0v18", next: "Move to bottom" },
  bottom: { path: "M3 3h18v18H3V3zm0 12h18", next: "Move to left" },
  left: { path: "M3 3h18v18H3V3zm6 0v18", next: "Move to right" },
};

function MenuSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">
        {title}
      </p>
      {children}
    </div>
  );
}

function MenuDivider() {
  return <div className="mx-2 my-1 h-px bg-border/50" />;
}

function MenuAction({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2.5 py-2 text-left text-[var(--text-sm)] text-foreground/90 transition-colors hover:bg-accent/50 motion-safe:duration-150",
        className,
      )}
    >
      {children}
    </button>
  );
}

interface AnalysisPanelMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportUnreadBadge: boolean;
  onExportOpen: () => void;
  onExportBadgeClear: () => void;
  analysisFontScale: number;
  bumpAnalysisFontScale: (delta: number) => void;
  setAnalysisFontScale: (scale: number) => void;
  analysisFontFamily: AnalysisFontFamily;
  setAnalysisFontFamily: (family: AnalysisFontFamily) => void;
  position: PanelPosition;
  onCyclePosition: () => void;
}

export function AnalysisPanelMenu({
  open,
  onOpenChange,
  exportUnreadBadge,
  onExportOpen,
  onExportBadgeClear,
  analysisFontScale,
  bumpAnalysisFontScale,
  setAnalysisFontScale,
  analysisFontFamily,
  setAnalysisFontFamily,
  position,
  onCyclePosition,
}: AnalysisPanelMenuProps) {
  const icon = positionIcons[position] || positionIcons.right;

  return (
    <OverflowMenu
      ariaLabel="Panel options"
      open={open}
      onOpenChange={onOpenChange}
      buttonProps={{
        className:
          "shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[popup-open]:bg-accent/60 motion-safe:duration-150",
        title: "Panel options — text size, font, pane position",
        "aria-label": "Panel options",
      }}
      triggerInner={
        <span className="relative inline-flex">
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <line x1="4" x2="4" y1="21" y2="14" />
            <line x1="4" x2="4" y1="10" y2="3" />
            <line x1="12" x2="12" y1="21" y2="12" />
            <line x1="12" x2="12" y1="8" y2="3" />
            <line x1="20" x2="20" y1="21" y2="16" />
            <line x1="20" x2="20" y1="12" y2="3" />
            <line x1="1" x2="7" y1="14" y2="14" />
            <line x1="9" x2="15" y1="8" y2="8" />
            <line x1="17" x2="23" y1="16" y2="16" />
          </svg>
          {exportUnreadBadge && (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground/50" />
          )}
        </span>
      }
      className="w-[17rem] border-border/50 p-1.5 shadow-[var(--shadow-sm)]"
    >
      <MenuSection title="Text size">
        <div className="flex items-center gap-1 px-2 pb-1">
          <button
            type="button"
            onClick={() => bumpAnalysisFontScale(-0.1)}
            disabled={analysisFontScale <= 0.85 + 1e-6}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/50 text-[var(--text-xs)] font-semibold hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40"
            aria-label="Decrease text size"
          >
            A−
          </button>
          <button
            type="button"
            onClick={() => setAnalysisFontScale(1)}
            disabled={Math.abs(analysisFontScale - 1) < 1e-6}
            className="inline-flex h-7 flex-1 items-center justify-center rounded-md border border-border/50 text-[var(--text-xs)] font-medium tabular-nums hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40"
            aria-label="Reset text size"
          >
            {Math.round(analysisFontScale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => bumpAnalysisFontScale(0.1)}
            disabled={analysisFontScale >= 1.6 - 1e-6}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/50 text-[var(--text-xs)] font-semibold hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40"
            aria-label="Increase text size"
          >
            A+
          </button>
        </div>
        <p className="px-2.5 pb-0.5 text-[10px] leading-snug text-muted-foreground/70">
          Saved across every paper and reload.
        </p>
      </MenuSection>

      <MenuDivider />

      <MenuSection title="Font family">
        <div className="grid grid-cols-2 gap-1 px-2 pb-1">
          {(
            [
              { id: "sans", label: "Sans" },
              { id: "serif", label: "Serif" },
              { id: "times", label: "Times" },
              { id: "arial", label: "Arial" },
              { id: "mono", label: "Mono" },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setAnalysisFontFamily(f.id as AnalysisFontFamily)}
              className={cn(
                "inline-flex h-7 items-center justify-center rounded-md border text-[var(--text-xs)] font-medium transition-colors motion-safe:duration-150",
                analysisFontFamily === f.id
                  ? "border-foreground/30 bg-accent/50 text-foreground"
                  : "border-border/50 bg-transparent text-foreground/80 hover:bg-accent/40",
              )}
              style={{ fontFamily: FAMILY_TO_VAR[f.id as AnalysisFontFamily] }}
              aria-pressed={analysisFontFamily === f.id}
            >
              {f.label}
            </button>
          ))}
        </div>
      </MenuSection>

      <MenuDivider />

      <MenuSection title="Export">
        <MenuAction
          onClick={() => {
            onExportBadgeClear();
            onOpenChange(false);
            onExportOpen();
          }}
        >
          Export analysis…
        </MenuAction>
        <div onClick={onExportBadgeClear} onKeyDown={() => {}} role="presentation">
          <ExportsMenu />
        </div>
      </MenuSection>

      <MenuDivider />

      <MenuSection title="Pane position">
        <MenuAction onClick={onCyclePosition}>
          <span className="flex flex-1 items-center gap-2">
            <svg
              className="h-3.5 w-3.5 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={icon.path} />
            </svg>
            {POSITION_LABEL[position]}
          </span>
          <span className="text-[10px] text-muted-foreground/75">{icon.next}</span>
        </MenuAction>
        <p className="px-2.5 pt-0.5 text-[10px] leading-snug text-muted-foreground/70">
          Saved across every paper and reload.
        </p>
      </MenuSection>
    </OverflowMenu>
  );
}
