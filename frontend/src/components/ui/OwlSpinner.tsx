"use client";

interface OwlSpinnerProps {
  size?: number;
  label?: string;
}

/**
 * Minimal modern spinner — a thin gradient arc that rotates over a faint
 * track. No logo, no chrome. Sized via the `size` prop; color follows
 * `currentColor` so callers control the tone with text-* utilities.
 */
export function OwlSpinner({ size = 32, label }: OwlSpinnerProps) {
  const stroke = Math.max(2, Math.round(size * 0.08));
  return (
    <div
      role="status"
      aria-label={label || "Loading"}
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        className="motion-safe:animate-[owl-ring_1s_linear_infinite]"
        viewBox="0 0 32 32"
        width={size}
        height={size}
        fill="none"
        aria-hidden
      >
        <circle
          cx="16"
          cy="16"
          r="13"
          stroke="currentColor"
          strokeOpacity="0.12"
          strokeWidth={stroke}
        />
        <path
          d="M16 3 a13 13 0 0 1 11.26 6.5"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
}
