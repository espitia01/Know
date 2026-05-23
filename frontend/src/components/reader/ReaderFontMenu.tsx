"use client";

import { OverflowMenu } from "@/components/analysis/OverflowMenu";
import { useStore, type ReaderFontFamily } from "@/lib/store";
import {
  READER_FAMILY_TO_VAR,
  bumpReaderFontScale,
  nearestReaderFontScale,
} from "@/lib/readerFont";

const FAMILIES: { id: ReaderFontFamily; label: string }[] = [
  { id: "serif", label: "Serif" },
  { id: "sans", label: "Sans" },
  { id: "mono", label: "Mono" },
];

export function ReaderFontMenu() {
  const readerFontScale = useStore((s) => s.uiPrefs.readerFontScale);
  const readerFontFamily = useStore((s) => s.uiPrefs.readerFontFamily);
  const setReaderFontScale = useStore((s) => s.setReaderFontScale);
  const setReaderFontFamily = useStore((s) => s.setReaderFontFamily);

  const scaleLabel = Math.round(nearestReaderFontScale(readerFontScale) * 100);

  return (
    <OverflowMenu
      ariaLabel="Reader font settings"
      align="end"
      triggerInner={
        <span className="text-[11px] font-semibold tracking-tight text-muted-foreground/90">
          Aa
        </span>
      }
      buttonProps={{
        className:
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-muted/[0.08] text-foreground/90 hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      }}
    >
      <div className="min-w-[10.5rem] space-y-3 p-2">
        <div>
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
            Size
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setReaderFontScale(bumpReaderFontScale(readerFontScale, -1))}
              className="flex-1 rounded-md border border-border/45 px-2 py-1 text-[var(--text-xs)] hover:bg-accent/40"
              aria-label="Decrease reader font size"
            >
              A−
            </button>
            <span className="min-w-[2.5rem] text-center text-[10px] tabular-nums text-muted-foreground">
              {scaleLabel}%
            </span>
            <button
              type="button"
              onClick={() => setReaderFontScale(bumpReaderFontScale(readerFontScale, 1))}
              className="flex-1 rounded-md border border-border/45 px-2 py-1 text-[var(--text-xs)] hover:bg-accent/40"
              aria-label="Increase reader font size"
            >
              A+
            </button>
          </div>
        </div>
        <div>
          <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
            Family
          </p>
          <div className="space-y-0.5">
            {FAMILIES.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setReaderFontFamily(f.id)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[var(--text-xs)] hover:bg-accent/40 ${
                  readerFontFamily === f.id ? "bg-accent/30 font-medium" : ""
                }`}
                style={{ fontFamily: READER_FAMILY_TO_VAR[f.id] }}
                aria-pressed={readerFontFamily === f.id}
              >
                {f.label}
                {readerFontFamily === f.id && (
                  <span className="text-muted-foreground/70" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </OverflowMenu>
  );
}
