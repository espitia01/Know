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
    size: "cover",
  },
  {
    id: "sky",
    label: "Sky",
    image:
      "radial-gradient(ellipse 85% 55% at 0% 0%, rgba(59, 130, 246, 0.09), transparent 60%), " +
      "radial-gradient(ellipse 60% 50% at 100% 100%, rgba(14, 165, 233, 0.05), transparent 60%)",
    size: "cover",
  },
  {
    id: "rose",
    label: "Rose",
    image:
      "radial-gradient(ellipse 80% 55% at 15% 10%, rgba(244, 114, 182, 0.08), transparent 58%), " +
      "radial-gradient(ellipse 70% 50% at 95% 90%, rgba(251, 146, 60, 0.05), transparent 60%)",
    size: "cover",
  },
  {
    id: "lavender",
    label: "Lavender",
    image:
      "radial-gradient(ellipse 80% 55% at 20% 0%, rgba(167, 139, 250, 0.09), transparent 58%), " +
      "radial-gradient(ellipse 60% 45% at 100% 80%, rgba(99, 102, 241, 0.05), transparent 60%)",
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
    size: "cover",
    repeat: "no-repeat",
  },
];

const STORAGE_KEY = "know-bg-image";

export type BackgroundState = {
  presetId: BackgroundPresetId;
  /** Data URL when `presetId === "custom"`; null otherwise. */
  customImage: string | null;
  /** Overall opacity scaler, 0–1. User-tunable so uploads can be dialed down. */
  opacity: number;
};

/**
 * Resolved CSS for a state — used by both `applyBackgroundState` at
 * runtime and the inline pre-paint init script, which can't import
 * from this module but *can* read JSON out of localStorage.
 */
type ResolvedBackgroundCss = {
  image: string; // "none" | "url(...)" | gradient string
  size: string;
  position: string;
  repeat: string;
  opacity: number;
};

const DEFAULT_STATE: BackgroundState = {
  presetId: "none",
  customImage: null,
  opacity: 0.5,
};

function resolveCss(state: BackgroundState): ResolvedBackgroundCss {
  if (state.presetId === "custom" && state.customImage) {
    return {
      image: `url("${state.customImage}")`,
      size: "cover",
      position: "center",
      repeat: "no-repeat",
      opacity: state.opacity,
    };
  }
  const preset = BACKGROUND_PRESETS.find((p) => p.id === state.presetId);
  if (preset && preset.id !== "none") {
    return {
      image: preset.image,
      size: preset.size ?? "cover",
      position: preset.position ?? "center",
      repeat: preset.repeat ?? "no-repeat",
      opacity: state.opacity,
    };
  }
  return {
    image: "none",
    size: "cover",
    position: "center",
    repeat: "no-repeat",
    opacity: 0,
  };
}

export function loadBackgroundState(): BackgroundState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
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
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveBackgroundState(state: BackgroundState): void {
  if (typeof window === "undefined") return;
  try {
    // Persist the resolved CSS alongside the symbolic state so the
    // synchronous init script (which can't import anything) can
    // hydrate the page before first paint — no matter whether the
    // user picked a preset or uploaded a custom image.
    const resolved = resolveCss(state);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, resolved }),
    );
  } catch {
    // Quota exceeded (very large custom image). We silently fail so
    // the user's choice simply doesn't persist across reloads.
  }
}

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
 * We attach to `document.documentElement` so every route picks it up
 * immediately — the picker lives in Settings but the user expects the
 * choice to follow them into the reader, library, and landing page
 * with no re-render dance.
 */
export function applyBackgroundState(state: BackgroundState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
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
    root.style.setProperty("--bg-user-image", preset.image);
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

export const DEFAULT_BACKGROUND_STATE = DEFAULT_STATE;

/**
 * Inline script string that runs synchronously before first paint to
 * hydrate the background CSS variables from localStorage. Without this
 * the user would see a brief flash of the default (plain) background
 * on every reload while React mounts the `BackgroundImageProvider`.
 *
 * Kept tiny and defensive — any throw here would stall the initial
 * paint, so we silently no-op on failure and let the React provider
 * re-apply the state as a safety net.
 */
export const BG_INIT_SCRIPT = `
(function () {
  try {
    var raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    if (!raw) return;
    var s = JSON.parse(raw);
    if (!s || typeof s !== "object") return;
    var r = s.resolved;
    if (!r || typeof r !== "object" || !r.image || r.image === "none") return;
    var op = typeof r.opacity === "number" ? Math.max(0, Math.min(1, r.opacity)) : 0.5;
    var root = document.documentElement;
    root.style.setProperty("--bg-user-image", r.image);
    root.style.setProperty("--bg-user-size", r.size || "cover");
    root.style.setProperty("--bg-user-repeat", r.repeat || "no-repeat");
    root.style.setProperty("--bg-user-position", r.position || "center");
    root.style.setProperty("--bg-user-opacity", String(op));
  } catch (e) { /* no-op */ }
})();
`.trim();
