"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BACKGROUND_PRESETS,
  BackgroundPresetId,
  BackgroundState,
  DEFAULT_BACKGROUND_STATE,
  applyBackgroundState,
  loadBackgroundState,
  prepareCustomImage,
  saveBackgroundState,
} from "@/lib/backgroundImage";

type Props = {
  /** The user's subscription tier; controls whether the picker is active. */
  tier: "free" | "scholar" | "researcher";
};

/**
 * Settings → Appearance section.
 *
 * Lets Scholar+ users pick a subtle background preset for the dashboard
 * and library, or upload a custom image. Free users see the picker
 * disabled with an upgrade CTA so the feature is discoverable but
 * clearly gated. The whole thing is client-side — preference is stored
 * in localStorage and applied via CSS custom properties on `:root`.
 */
export function AppearanceSection({ tier }: Props) {
  const entitled = tier === "scholar" || tier === "researcher";

  const [state, setState] = useState<BackgroundState>(DEFAULT_BACKGROUND_STATE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Hydrate from localStorage on mount so the preview reflects the
  // user's actual saved choice the moment the panel opens.
  useEffect(() => {
    setState(loadBackgroundState());
  }, []);

  const persist = useCallback((next: BackgroundState) => {
    setState(next);
    saveBackgroundState(next);
    applyBackgroundState(next);
  }, []);

  const selectPreset = useCallback(
    (id: BackgroundPresetId) => {
      if (!entitled) return;
      // Switching away from a custom upload wipes the cached data URL —
      // otherwise it hangs around in localStorage wasting quota. The
      // user can always upload again.
      const next: BackgroundState =
        id === "custom"
          ? { ...state, presetId: "custom" }
          : { ...state, presetId: id, customImage: null };
      persist(next);
    },
    [entitled, state, persist],
  );

  const onFilePicked = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      try {
        const dataUrl = await prepareCustomImage(file);
        persist({ presetId: "custom", customImage: dataUrl, opacity: state.opacity });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Could not read that image.";
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [persist, state.opacity],
  );

  const setOpacity = useCallback(
    (value: number) => persist({ ...state, opacity: value }),
    [state, persist],
  );

  const resetAll = useCallback(() => {
    persist(DEFAULT_BACKGROUND_STATE);
  }, [persist]);

  return (
    <div className="glass rounded-2xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[14px] font-semibold text-foreground">Appearance</p>
          <p className="text-[11px] text-muted-foreground/80 mt-0.5">
            Pick a subtle background for the dashboard and library.
          </p>
        </div>
        {!entitled && (
          <span className="text-[11px] text-muted-foreground glass-subtle px-2.5 py-1 rounded-full font-medium">
            Scholar+
          </span>
        )}
      </div>

      {!entitled ? (
        <div className="rounded-xl glass-subtle px-4 py-4 space-y-2">
          <p className="text-[12.5px] text-foreground/90">
            Customize the dashboard background with curated presets or your own
            image.
          </p>
          <p className="text-[11.5px] text-muted-foreground">
            Available on Scholar and Researcher plans.
          </p>
          <div className="pt-1">
            <Link
              href="/#pricing"
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-foreground hover:text-foreground/80 transition-colors"
            >
              View plans <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Preset grid */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {BACKGROUND_PRESETS.map((p) => {
              const active = state.presetId === p.id;
              const swatchStyle: React.CSSProperties =
                p.id === "none"
                  ? { background: "var(--background)" }
                  : {
                      backgroundImage: p.image,
                      backgroundSize: p.size ?? "cover",
                      backgroundRepeat: p.repeat ?? "no-repeat",
                      backgroundPosition: p.position ?? "center",
                      backgroundColor: "var(--background)",
                    };
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectPreset(p.id)}
                  className={`group relative aspect-[4/3] rounded-xl overflow-hidden border transition-all ring-focus ${
                    active
                      ? "border-foreground/50 shadow-sm"
                      : "border-border hover:border-border-strong"
                  }`}
                  aria-pressed={active}
                  aria-label={`Use ${p.label} background`}
                >
                  <div className="absolute inset-0" style={swatchStyle} />
                  <div className="absolute inset-0 flex items-end justify-start p-1.5 pointer-events-none">
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-background/80 text-foreground/90 backdrop-blur-sm">
                      {p.label}
                    </span>
                  </div>
                  {active && (
                    <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-foreground text-background flex items-center justify-center">
                      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </button>
              );
            })}

            {/* Custom upload slot — sits beside the presets so it reads as
                a peer option rather than a secondary concern. */}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className={`group relative aspect-[4/3] rounded-xl overflow-hidden border-2 border-dashed transition-all ring-focus ${
                state.presetId === "custom" && state.customImage
                  ? "border-foreground/50"
                  : "border-border hover:border-border-strong"
              } flex items-center justify-center disabled:opacity-60`}
              aria-label="Upload custom background"
            >
              {state.presetId === "custom" && state.customImage ? (
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage: `url("${state.customImage}")`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }}
                />
              ) : null}
              <div className="relative flex flex-col items-center gap-1 text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className="px-1.5 py-0.5 rounded-md bg-background/80 backdrop-blur-sm">
                  {busy ? "Processing…" : "Upload"}
                </span>
              </div>
            </button>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFilePicked(f);
              // Reset so picking the same file twice still triggers onChange.
              e.target.value = "";
            }}
          />

          {error && (
            <p className="text-[12px] text-destructive">{error}</p>
          )}

          {/* Opacity slider — the image can feel overwhelming even at
              low alpha, so the user gets a direct dial. */}
          <div className="pt-1 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <label htmlFor="bg-opacity">Intensity</label>
              <span className="tabular-nums">
                {Math.round(state.opacity * 100)}%
              </span>
            </div>
            <input
              id="bg-opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              className="w-full accent-foreground"
              disabled={state.presetId === "none"}
            />
          </div>

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={resetAll}
              className="text-[11.5px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Reset to default
            </button>
          </div>
        </>
      )}
    </div>
  );
}
