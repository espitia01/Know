import type { ReaderFontFamily } from "@/lib/store";

/** Reader-only font stacks (separate from analysis pane). */
export const READER_FAMILY_TO_VAR: Record<ReaderFontFamily, string> = {
  serif: "'Charter', 'Iowan Old Style', 'Source Serif Pro', Georgia, serif",
  sans: "var(--font-inter), system-ui, -apple-system, sans-serif",
  mono: "var(--font-jetbrains-mono), ui-monospace, Menlo, Consolas, monospace",
};

export const READER_FONT_SCALES = [0.92, 1.0, 1.12, 1.25] as const;

export function nearestReaderFontScale(v: number): number {
  return READER_FONT_SCALES.reduce((best, cur) =>
    Math.abs(cur - v) < Math.abs(best - v) ? cur : best,
  );
}

export function bumpReaderFontScale(current: number, delta: number): number {
  const idx = READER_FONT_SCALES.indexOf(nearestReaderFontScale(current) as (typeof READER_FONT_SCALES)[number]);
  const base = idx >= 0 ? idx : READER_FONT_SCALES.indexOf(1.0);
  const next = Math.max(0, Math.min(READER_FONT_SCALES.length - 1, base + delta));
  return READER_FONT_SCALES[next];
}
