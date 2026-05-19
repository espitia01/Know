/**
 * Custom dashboard / library background image for Scholar+ and Researcher
 * users.
 *
 * The feature is deliberately client-only: the chosen preset or uploaded
 * image is small, per-device UX, and has no value on the server. We
 * persist to localStorage, apply via CSS variables (`--bg-user-image`,
 * `--bg-user-opacity`, …) that a `body::before` pseudo-element paints
 * behind the app, and downscale uploads so we never blow the
 * localStorage quota (~5 MB in most browsers) with a single 4K photo.
 *
 * Presets are inline SVG data URLs so they ship with the JS bundle and
 * never require a network round-trip to render. They are intentionally
 * near-white with very low-contrast colour so the dashboard feels
 * "almost white but with some colour", which is what the user asked
 * for. Alpha bands are tight — all fills sit between 0.03 and 0.10 so
 * surface cards still feel like they sit on top of the page instead of
 * competing with the background for attention.
 */

export type BackgroundPresetId =
  | "none"
  | "mint"
  | "sky"
  | "rose"
  | "lavender"
  | "dots"
  | "grid"
  | "waves"
  | "custom";

export type BackgroundPreset = {
  id: BackgroundPresetId;
  label: string;
  /** CSS `background-image` value (image, gradient, or combination). */
  image: string;
  /**
   * When `.dark` is on the root, this replaces `image` so patterns stay
   * legible (light-ink-on-light presets look muddy on near-black).
   */
  imageDark?: string;
  /** Optional `background-size` — defaults to `cover` when omitted. */
  size?: string;
  /** Optional `background-repeat` — defaults to `no-repeat` when omitted. */
  repeat?: string;
  /** Optional `background-position` — defaults to `center` when omitted. */
  position?: string;
};

// Inline SVG helper — wrap an SVG string in a data URL suitable for
// `background-image: url(...)`. URI-encoding rather than base64 keeps
// the payload ~30% smaller and remains CSS-compatible.
const svg = (body: string, viewBox = "0 0 200 200") =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${viewBox}'>${body}</svg>`,
  )}")`;

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: "none",
    label: "Clean",
    image: "none",
  },
  {
    id: "mint",
    label: "Mint",
    image:
      "radial-gradient(ellipse 90% 60% at 10% 0%, rgba(52, 211, 153, 0.10), transparent 55%), " +
      "radial-gradient(ellipse 60% 50% at 100% 100%, rgba(59, 130, 246, 0.05), transparent 60%)",
    imageDark:
      "radial-gradient(ellipse 85% 55% at 8% 5%, rgba(52, 211, 153, 0.11), transparent 58%), " +
      "radial-gradient(ellipse 70% 50% at 100% 100%, rgba(45, 212, 191, 0.06), transparent 62%), " +
      "radial-gradient(ellipse 50% 40% at 50% 50%, rgba(15, 118, 110, 0.14), transparent 70%)",
    size: "cover",
  },
  {
    id: "sky",
    label: "Sky",
    image:
      "radial-gradient(ellipse 85% 55% at 0% 0%, rgba(59, 130, 246, 0.09), transparent 60%), " +
      "radial-gradient(ellipse 60% 50% at 100% 100%, rgba(14, 165, 233, 0.05), transparent 60%)",
    imageDark:
      "radial-gradient(ellipse 90% 60% at 5% 0%, rgba(96, 165, 250, 0.14), transparent 55%), " +
      "radial-gradient(ellipse 65% 50% at 100% 95%, rgba(56, 189, 248, 0.08), transparent 60%), " +
      "radial-gradient(ellipse 45% 35% at 70% 30%, rgba(30, 64, 175, 0.20), transparent 72%)",
    size: "cover",
  },
  {
    id: "rose",
    label: "Rose",
    image:
      "radial-gradient(ellipse 80% 55% at 15% 10%, rgba(244, 114, 182, 0.08), transparent 58%), " +
      "radial-gradient(ellipse 70% 50% at 95% 90%, rgba(251, 146, 60, 0.05), transparent 60%)",
    imageDark:
      "radial-gradient(ellipse 80% 55% at 12% 8%, rgba(251, 113, 133, 0.12), transparent 58%), " +
      "radial-gradient(ellipse 75% 50% at 95% 90%, rgba(244, 63, 94, 0.07), transparent 62%), " +
      "radial-gradient(ellipse 40% 35% at 50% 60%, rgba(136, 19, 55, 0.18), transparent 75%)",
    size: "cover",
  },
  {
    id: "lavender",
    label: "Lavender",
    image:
      "radial-gradient(ellipse 80% 55% at 20% 0%, rgba(167, 139, 250, 0.09), transparent 58%), " +
      "radial-gradient(ellipse 60% 45% at 100% 80%, rgba(99, 102, 241, 0.05), transparent 60%)",
    imageDark:
      "radial-gradient(ellipse 82% 58% at 18% 0%, rgba(167, 139, 250, 0.13), transparent 56%), " +
      "radial-gradient(ellipse 65% 48% at 100% 85%, rgba(129, 140, 248, 0.09), transparent 58%), " +
      "radial-gradient(ellipse 42% 38% at 55% 45%, rgba(67, 56, 202, 0.16), transparent 74%)",
    size: "cover",
  },
  {
    id: "dots",
    label: "Dots",
    image: svg(
      `<defs>
        <pattern id='p' width='28' height='28' patternUnits='userSpaceOnUse'>
          <circle cx='2' cy='2' r='1' fill='rgba(15, 23, 42, 0.10)'/>
        </pattern>
        <radialGradient id='w' cx='50%' cy='0%' r='80%'>
          <stop offset='0%' stop-color='rgba(59, 130, 246, 0.06)'/>
          <stop offset='100%' stop-color='rgba(255, 255, 255, 0)'/>
        </radialGradient>
      </defs>
      <rect width='200' height='200' fill='url(#w)'/>
      <rect width='200' height='200' fill='url(#p)'/>`,
    ),
    imageDark: svg(
      `<defs>
        <pattern id='pd' width='28' height='28' patternUnits='userSpaceOnUse'>
          <circle cx='2' cy='2' r='1' fill='rgba(226, 232, 240, 0.065)'/>
        </pattern>
        <radialGradient id='wd' cx='50%' cy='0%' r='75%'>
          <stop offset='0%' stop-color='rgba(96, 165, 250, 0.09)'/>
          <stop offset='100%' stop-color='rgba(15, 23, 42, 0)'/>
        </radialGradient>
      </defs>
      <rect width='200' height='200' fill='url(#wd)'/>
      <rect width='200' height='200' fill='url(#pd)'/>`,
    ),
    size: "auto",
    repeat: "repeat",
    position: "0 0",
  },
  {
    id: "grid",
    label: "Graph paper",
    image: svg(
      `<defs>
        <pattern id='g' width='36' height='36' patternUnits='userSpaceOnUse'>
          <path d='M 36 0 L 0 0 0 36' fill='none' stroke='rgba(15, 23, 42, 0.07)' stroke-width='0.5'/>
        </pattern>
        <radialGradient id='t' cx='0%' cy='0%' r='90%'>
          <stop offset='0%' stop-color='rgba(99, 102, 241, 0.05)'/>
          <stop offset='100%' stop-color='rgba(255, 255, 255, 0)'/>
        </radialGradient>
      </defs>
      <rect width='200' height='200' fill='url(#t)'/>
      <rect width='200' height='200' fill='url(#g)'/>`,
    ),
    imageDark: svg(
      `<defs>
        <pattern id='gd' width='36' height='36' patternUnits='userSpaceOnUse'>
          <path d='M 36 0 L 0 0 0 36' fill='none' stroke='rgba(148, 163, 184, 0.09)' stroke-width='0.5'/>
        </pattern>
        <radialGradient id='td' cx='0%' cy='0%' r='88%'>
          <stop offset='0%' stop-color='rgba(99, 102, 241, 0.08)'/>
          <stop offset='100%' stop-color='rgba(15, 23, 42, 0)'/>
        </radialGradient>
      </defs>
      <rect width='200' height='200' fill='url(#td)'/>
      <rect width='200' height='200' fill='url(#gd)'/>`,
    ),
    size: "auto",
    repeat: "repeat",
    position: "0 0",
  },
  {
    id: "waves",
    label: "Waves",
    image: svg(
      `<defs>
        <linearGradient id='w' x1='0' x2='1' y1='0' y2='1'>
          <stop offset='0%' stop-color='rgba(59, 130, 246, 0.05)'/>
          <stop offset='100%' stop-color='rgba(236, 72, 153, 0.03)'/>
        </linearGradient>
      </defs>
      <rect width='400' height='400' fill='url(#w)'/>
      <path d='M0 150 Q100 100 200 150 T400 150' fill='none' stroke='rgba(15, 23, 42, 0.05)' stroke-width='1'/>
      <path d='M0 220 Q100 170 200 220 T400 220' fill='none' stroke='rgba(15, 23, 42, 0.04)' stroke-width='1'/>
      <path d='M0 290 Q100 240 200 290 T400 290' fill='none' stroke='rgba(15, 23, 42, 0.035)' stroke-width='1'/>`,
      "0 0 400 400",
    ),
    imageDark: svg(
      `<defs>
        <linearGradient id='wd' x1='0' x2='1' y1='0' y2='1'>
          <stop offset='0%' stop-color='rgba(96, 165, 250, 0.07)'/>
          <stop offset='55%' stop-color='rgba(129, 140, 248, 0.04)'/>
          <stop offset='100%' stop-color='rgba(244, 114, 182, 0.05)'/>
        </linearGradient>
      </defs>
      <rect width='400' height='400' fill='url(#wd)'/>
      <path d='M0 150 Q100 100 200 150 T400 150' fill='none' stroke='rgba(226, 232, 240, 0.065)' stroke-width='1'/>
      <path d='M0 220 Q100 170 200 220 T400 220' fill='none' stroke='rgba(226, 232, 240, 0.05)' stroke-width='1'/>
      <path d='M0 290 Q100 240 200 290 T400 290' fill='none' stroke='rgba(226, 232, 240, 0.04)' stroke-width='1'/>`,
      "0 0 400 400",
    ),
    size: "cover",
    repeat: "no-repeat",
  },
];

/** Preset artwork for UI previews — matches {@link applyBackgroundState} light/dark choice. */
export function presetDisplayImage(preset: BackgroundPreset, dark: boolean): string {
  if (preset.id === "none") return "none";
  return dark && preset.imageDark ? preset.imageDark : preset.image;
}

/** @deprecated Pre–per-user storage; no longer read (avoid cross-account bleed). */
export const LEGACY_BACKGROUND_STORAGE_KEY = "know-bg-image";

export function backgroundStorageKey(userId: string): string {
  return `know-bg:v2:${userId}`;
}

export type BackgroundState = {
  presetId: BackgroundPresetId;
  /** Data URL when `presetId === "custom"`; null otherwise. */
  customImage: string | null;
  /** Overall opacity scaler, 0–1. User-tunable so uploads can be dialed down. */
  opacity: number;
};

const DEFAULT_STATE: BackgroundState = {
  presetId: "none",
  customImage: null,
  opacity: 0.5,
};

export const DEFAULT_BACKGROUND_STATE = DEFAULT_STATE;

function parseBackgroundPayload(raw: string): BackgroundState {
  const parsed = JSON.parse(raw) as Partial<BackgroundState>;
  return {
    presetId: (parsed.presetId as BackgroundPresetId) || "none",
    customImage: parsed.customImage ?? null,
    opacity:
      typeof parsed.opacity === "number" &&
      parsed.opacity >= 0 &&
      parsed.opacity <= 1
        ? parsed.opacity
        : 0.5,
  };
}

/** Server is source of truth; localStorage is a first-paint cache only. */
export function readBackgroundCache(userId: string | null): BackgroundState {
  if (typeof window === "undefined" || !userId) return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(backgroundStorageKey(userId));
    if (!raw) return DEFAULT_STATE;
    return parseBackgroundPayload(raw);
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeBackgroundCache(state: BackgroundState, userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    window.localStorage.setItem(backgroundStorageKey(userId), JSON.stringify(state));
    window.localStorage.removeItem(LEGACY_BACKGROUND_STORAGE_KEY);
  } catch {
    // Quota exceeded — cache write is best-effort.
  }
}

/** @deprecated Use {@link readBackgroundCache}. */
export const loadBackgroundStateForUser = readBackgroundCache;

/** @deprecated Use {@link writeBackgroundCache}. */
export const saveBackgroundStateForUser = writeBackgroundCache;

/**
 * Downscale an uploaded image to a sensible size and re-encode it as
 * WebP so we never blow through the ~5 MB localStorage cap with a
 * single 4K photo. The output is a data URL ready to drop into
 * `background-image: url(...)`.
 */
export async function prepareCustomImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please pick an image file (PNG, JPG, WebP, or SVG).");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Image is too large. Please pick one under 8 MB.");
  }
  // SVG passes through untouched — re-encoding through a canvas would
  // raster the vectors and ruin their crispness at high-DPI. We still
  // enforce the size cap above.
  if (file.type === "image/svg+xml") {
    const text = await file.text();
    return `data:image/svg+xml;utf8,${encodeURIComponent(text)}`;
  }

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("Could not read that image.");

  const maxW = 1920;
  const maxH = 1200;
  const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported in this browser.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // Try WebP first — drastically smaller than PNG for photos. Fall
  // back to JPEG if the browser doesn't support toDataURL for webp.
  let dataUrl = canvas.toDataURL("image/webp", 0.85);
  if (!dataUrl.startsWith("data:image/webp")) {
    dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  }
  if (dataUrl.length > 3_500_000) {
    throw new Error(
      "This image is too heavy after compression. Try a smaller one.",
    );
  }
  return dataUrl;
}

/**
 * Apply the given state to the document by writing the CSS custom
 * properties that `body::before` (and any other `bg-user-layer`
 * consumers) read.
 *
 * When `resolvedDark` is set, it selects the light vs dark preset
 * artwork and stays in sync with {@link ThemeProvider}'s resolved mode
 * (the `.dark` class can lag by a frame right after hydration).
 */
export function applyBackgroundState(
  state: BackgroundState,
  resolvedDark?: boolean,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const dark =
    resolvedDark !== undefined
      ? resolvedDark
      : root.classList.contains("dark");
  const preset =
    state.presetId === "custom"
      ? null
      : BACKGROUND_PRESETS.find((p) => p.id === state.presetId);

  if (state.presetId === "custom" && state.customImage) {
    root.style.setProperty("--bg-user-image", `url("${state.customImage}")`);
    root.style.setProperty("--bg-user-size", "cover");
    root.style.setProperty("--bg-user-repeat", "no-repeat");
    root.style.setProperty("--bg-user-position", "center");
    root.style.setProperty("--bg-user-opacity", String(state.opacity));
  } else if (preset && preset.id !== "none") {
    const image = dark && preset.imageDark ? preset.imageDark : preset.image;
    root.style.setProperty("--bg-user-image", image);
    root.style.setProperty("--bg-user-size", preset.size ?? "cover");
    root.style.setProperty("--bg-user-repeat", preset.repeat ?? "no-repeat");
    root.style.setProperty("--bg-user-position", preset.position ?? "center");
    root.style.setProperty("--bg-user-opacity", String(state.opacity));
  } else {
    // No preset chosen — collapse the layer so the default look
    // (base gradients only) is visible.
    root.style.removeProperty("--bg-user-image");
    root.style.removeProperty("--bg-user-size");
    root.style.removeProperty("--bg-user-repeat");
    root.style.removeProperty("--bg-user-position");
    root.style.setProperty("--bg-user-opacity", "0");
  }
}
