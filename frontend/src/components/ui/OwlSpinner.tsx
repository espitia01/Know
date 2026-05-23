"use client";

import Image from "next/image";

interface OwlSpinnerProps {
  size?: number;
  label?: string;
}

/**
 * Owl-themed loading spinner: the logo softly pulses inside a thin
 * orbiting progress ring. Used wherever a paper- or analysis-scoped
 * operation is in flight.
 */
export function OwlSpinner({ size = 56, label }: OwlSpinnerProps) {
  const ring = size + 16;
  return (
    <div
      role="status"
      aria-label={label || "Loading"}
      className="relative inline-flex items-center justify-center"
      style={{ width: ring, height: ring }}
    >
      <svg
        className="absolute inset-0 motion-safe:animate-[owl-ring_2.4s_linear_infinite]"
        viewBox={`0 0 ${ring} ${ring}`}
        fill="none"
        aria-hidden
      >
        <circle
          cx={ring / 2}
          cy={ring / 2}
          r={ring / 2 - 2}
          stroke="currentColor"
          strokeOpacity="0.12"
          strokeWidth="2"
        />
        <circle
          cx={ring / 2}
          cy={ring / 2}
          r={ring / 2 - 2}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(ring - 4) * 0.3} ${(ring - 4) * 0.7}`}
        />
      </svg>
      <div
        className="relative flex items-center justify-center rounded-2xl border border-border/45 bg-card/35 shadow-[var(--shadow-xs)] motion-safe:animate-[owl-pulse_2s_ease-in-out_infinite] dark:bg-card/22"
        style={{ width: size, height: size }}
      >
        <Image
          src="/logo.png"
          alt=""
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          className="rounded-md opacity-90"
          aria-hidden
        />
      </div>
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
}
