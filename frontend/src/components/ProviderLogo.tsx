/**
 * Provider brand marks rendered inline so we never depend on a CDN and
 * always tint correctly in dark mode (`currentColor`).
 *
 * Provenance of the SVG paths:
 *   - Anthropic: `simple-icons` v16+ (CC0). Source slug `anthropic`.
 *                https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/anthropic.svg
 *   - Mistral AI: `simple-icons` v16+ (CC0). Source slug `mistralai`.
 *                https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/mistralai.svg
 *   - OpenAI:     Wikimedia Commons "OpenAI Logo.svg" (public domain). The
 *                wordmark canvas (`viewBox="0 0 1180 320"`) ships only the
 *                six-petal knot path here, cropped to its bounding box.
 *                https://commons.wikimedia.org/wiki/File:OpenAI_Logo.svg
 *
 * All three marks use `fill="currentColor"` so the icon inherits the
 * surrounding text color in both light and dark mode. Pass the optional
 * `tone` prop only when you want a coloured tinted disc behind the mark.
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
  // Inner mark is slightly inset (4px) so the disc has visible padding.
  const innerSize = tone === "none" ? size : Math.max(8, size - 4);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-md"
      style={{ width: size, height: size, backgroundColor: bg }}
    >
      {provider === "anthropic" && <AnthropicMark size={innerSize} {...rest} />}
      {provider === "openai" && <OpenAIMark size={innerSize} {...rest} />}
      {provider === "mistral" && <MistralMark size={innerSize} {...rest} />}
    </span>
  );
}

/** Anthropic — official A mark (simple-icons v16, CC0). */
function AnthropicMark({ size, ...rest }: { size: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      role="img"
      aria-label="Anthropic"
      {...rest}
    >
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  );
}

/**
 * OpenAI — official six-petal knot, extracted from the Wikimedia
 * Commons "OpenAI Logo.svg" wordmark. The path's natural bounding box
 * is approximately x=24..310, y=0..320 inside the 1180×320 wordmark
 * canvas; we crop with `viewBox="24 0 286 320"`.
 */
function OpenAIMark({ size, ...rest }: { size: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="24 0 286 320"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      role="img"
      aria-label="OpenAI"
      {...rest}
    >
      <path d="M297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z" />
    </svg>
  );
}

/** Mistral AI — official pixel-grid mark (simple-icons v16, CC0). */
function MistralMark({ size, ...rest }: { size: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      role="img"
      aria-label="Mistral AI"
      {...rest}
    >
      <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
    </svg>
  );
}

/** Provider → display label for headers. Keep in sync with `MODELS` in Settings. */
export const PROVIDER_LABEL: Record<ProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  mistral: "Mistral AI",
};
