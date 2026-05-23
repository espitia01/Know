"use client";

import { OverflowMenu } from "@/components/analysis/OverflowMenu";
import {
  useStore,
  type ReaderFontFamily,
  type ReaderLayoutStyle,
  type ReaderLayoutWidth,
} from "@/lib/store";
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

const WIDTHS: { id: ReaderLayoutWidth; label: string }[] = [
  { id: "compact", label: "Compact" },
  { id: "standard", label: "Standard" },
  { id: "wide", label: "Wide" },
];

const STYLES: { id: ReaderLayoutStyle; label: string; hint: string }[] = [
  { id: "journal", label: "Journal", hint: "Serif body, uppercase section headings" },
  { id: "modern", label: "Modern", hint: "Sans body, no all-caps headings" },
  { id: "plain", label: "Plain", hint: "No section underlines" },
];

function MenuLabel({ children }: { children: string }) {
  return (
    <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
      {children}
    </p>
  );
}

export function ReaderFontMenu() {
  const readerFontScale = useStore((s) => s.uiPrefs.readerFontScale);
  const readerFontFamily = useStore((s) => s.uiPrefs.readerFontFamily);
  const readerLayoutWidth = useStore((s) => s.uiPrefs.readerLayoutWidth);
  const readerLayoutStyle = useStore((s) => s.uiPrefs.readerLayoutStyle);
  const setReaderFontScale = useStore((s) => s.setReaderFontScale);
  const setReaderFontFamily = useStore((s) => s.setReaderFontFamily);
  const setReaderLayoutWidth = useStore((s) => s.setReaderLayoutWidth);
  const setReaderLayoutStyle = useStore((s) => s.setReaderLayoutStyle);

  const scaleLabel = Math.round(nearestReaderFontScale(readerFontScale) * 100);

  return (
    <OverflowMenu
      ariaLabel="Reader appearance"
      align="end"
      className="w-[19rem] p-3"
      triggerInner={
        <span className="text-[11.5px] font-semibold tracking-tight text-muted-foreground/90">
          Aa
        </span>
      }
      buttonProps={{
        className:
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-muted/[0.08] text-foreground/90 hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      }}
    >
      <div className="space-y-3.5">
        <div>
          <MenuLabel>Size</MenuLabel>
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
          <MenuLabel>Width</MenuLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {WIDTHS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setReaderLayoutWidth(w.id)}
                className={`rounded-md border border-border/45 px-2 py-1.5 text-[11px] font-medium leading-none hover:bg-accent/40 motion-safe:transition-colors motion-safe:duration-150 ${
                  readerLayoutWidth === w.id
                    ? "border-foreground/45 bg-accent/35 text-foreground"
                    : "text-muted-foreground/90"
                }`}
                aria-pressed={readerLayoutWidth === w.id}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <MenuLabel>Style</MenuLabel>
          <div className="space-y-0.5">
            {STYLES.map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setReaderLayoutStyle(st.id)}
                title={st.hint}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[var(--text-xs)] hover:bg-accent/40 ${
                  readerLayoutStyle === st.id ? "bg-accent/30 font-medium" : ""
                }`}
                aria-pressed={readerLayoutStyle === st.id}
              >
                {st.label}
                {readerLayoutStyle === st.id && (
                  <span className="text-muted-foreground/70" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div>
          <MenuLabel>Family</MenuLabel>
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
