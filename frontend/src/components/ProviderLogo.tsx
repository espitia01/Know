/**
 * Provider brand marks rendered inline so we never depend on a CDN and
 * always tint correctly in dark mode (`currentColor`).
 *
 * The SVG paths below are simplified monochrome approximations of each
 * provider's official mark, suitable for tiny (16–24px) icon usage in
 * the Settings model picker. If you ever want a pixel-perfect replica,
 * pull the original asset from each brand's press kit:
 *   - Anthropic: https://www.anthropic.com/news (press kit on footer)
 *   - OpenAI:    https://openai.com/brand
 *   - Mistral:   https://mistral.ai/news (assets at the bottom of any press page)
 *
 * Use `currentColor` for all fills/strokes so the icon inherits the
 * surrounding text color. Pass `tone` only when you want a coloured
 * accent (renders behind the mark as a soft circle).
 */

import type { SVGProps } from "react";

export type ProviderName = "anthropic" | "openai" | "mistral";

interface ProviderLogoProps extends Omit<SVGProps<SVGSVGElement>, "viewBox" | "xmlns"> {
  provider: ProviderName;
  size?: number;
  /** Renders a soft tinted disc behind the mark. Defaults to none. */
  tone?: "warm" | "cool" | "neutral" | "none";
}

const TONE_BG: Record<NonNullable<ProviderLogoProps["tone"]>, string> = {
  warm: "rgb(251 146 60 / 0.12)",   // amber-ish, matches Mistral's brand
  cool: "rgb(56 132 244 / 0.12)",   // blue-ish, neutral tech
  neutral: "rgb(113 113 122 / 0.10)",
  none: "transparent",
};

export function ProviderLogo({
  provider,
  size = 16,
  tone = "none",
  ...rest
}: ProviderLogoProps) {
  const bg = TONE_BG[tone];
  // Wrap in a fixed-size span so the optional tinted disc renders at the
  // requested icon size regardless of inner SVG viewBox aspect ratio.
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-md"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
      }}
    >
      {provider === "anthropic" && <AnthropicMark size={size - 4} {...rest} />}
      {provider === "openai" && <OpenAIMark size={size - 4} {...rest} />}
      {provider === "mistral" && <MistralMark size={size - 4} {...rest} />}
    </span>
  );
}

/**
 * Anthropic — angular A mark. Simplified from the wordmark glyph.
 * Single closed path so it tints cleanly via `currentColor`.
 */
function AnthropicMark({ size, ...rest }: { size: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 92 64"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      role="img"
      aria-label="Anthropic"
      {...rest}
    >
      <path d="M66.5 0h-12.8L70.6 64H92L66.5 0Zm-41 0L0 64h13.7l5.2-13.6h26.7L50.8 64h13.7L39 0H25.5Zm-2.8 38.9 9.1-23.7 9.1 23.7H22.7Z" />
    </svg>
  );
}

/**
 * OpenAI — the official six-petal knot, monochrome.
 * Complex path; kept as a single `<path d="…">` for compactness.
 */
function OpenAIMark({ size, ...rest }: { size: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      role="img"
      aria-label="OpenAI"
      {...rest}
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
    </svg>
  );
}

/**
 * Mistral — pixelated chevron/M stack. The official mark is an
 * orange-to-yellow gradient grid; here we render a single-tone
 * five-row staircase that reads as an "M" at small sizes.
 */
function MistralMark({ size, ...rest }: { size: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      role="img"
      aria-label="Mistral AI"
      {...rest}
    >
      {/* Row 1 — outer caps */}
      <rect x="0"   y="0"   width="48" height="48" />
      <rect x="208" y="0"   width="48" height="48" />
      {/* Row 2 — wider stretch */}
      <rect x="0"   y="52"  width="100" height="48" />
      <rect x="156" y="52"  width="100" height="48" />
      {/* Row 3 — middle peak */}
      <rect x="0"   y="104" width="48"  height="48" />
      <rect x="104" y="104" width="48"  height="48" />
      <rect x="208" y="104" width="48"  height="48" />
      {/* Row 4 — straight legs */}
      <rect x="0"   y="156" width="48"  height="48" />
      <rect x="208" y="156" width="48"  height="48" />
      {/* Row 5 — feet */}
      <rect x="0"   y="208" width="48"  height="48" />
      <rect x="208" y="208" width="48"  height="48" />
    </svg>
  );
}

/** Provider → display label for headers. Keep in sync with `MODELS` in Settings. */
export const PROVIDER_LABEL: Record<ProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  mistral: "Mistral AI",
};
