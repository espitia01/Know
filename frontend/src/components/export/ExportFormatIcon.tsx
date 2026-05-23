"use client";

import { cn } from "@/lib/utils";

type ExportFormat = "pdf" | "pptx" | "podcast";

const META: Record<
  ExportFormat,
  { label: string; bg: string; ariaLabel: string }
> = {
  pdf: {
    label: "PDF",
    bg: "bg-red-500/12 text-red-600 dark:text-red-400",
    ariaLabel: "PDF document",
  },
  pptx: {
    label: "PPT",
    bg: "bg-orange-500/12 text-orange-600 dark:text-orange-400",
    ariaLabel: "PowerPoint presentation",
  },
  podcast: {
    label: "MP3",
    bg: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
    ariaLabel: "Podcast audio",
  },
};

/** Branded format badge — PDF / PowerPoint / audio, no external assets. */
export function ExportFormatIcon({
  format,
  size = "md",
  className,
}: {
  format: ExportFormat;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const meta = META[format];
  const dim =
    size === "lg" ? "h-12 w-12 rounded-xl" : size === "sm" ? "h-7 w-7 rounded-md" : "h-9 w-9 rounded-lg";
  const text = size === "lg" ? "text-[13px]" : size === "sm" ? "text-[9px]" : "text-[10px]";

  return (
    <span
      role="img"
      aria-label={meta.ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-display font-bold tracking-tight",
        dim,
        meta.bg,
        className,
      )}
    >
      <span className={text}>{meta.label}</span>
    </span>
  );
}

export function exportFormatLabel(format: ExportFormat): string {
  if (format === "pdf") return "PDF document";
  if (format === "pptx") return "PowerPoint deck";
  return "Podcast (MP3)";
}
