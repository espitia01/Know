import type { AnalysisFontFamily } from "@/lib/store";

export const FAMILY_TO_VAR: Record<AnalysisFontFamily, string> = {
  sans: "var(--font-inter), system-ui, -apple-system, sans-serif",
  serif: "var(--font-source-serif), Georgia, 'Times New Roman', serif",
  mono: "var(--font-jetbrains-mono), ui-monospace, Menlo, Consolas, monospace",
  times: "'Times New Roman', Times, Georgia, serif",
  arial: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
};
