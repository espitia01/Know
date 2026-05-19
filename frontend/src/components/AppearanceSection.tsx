"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BACKGROUND_PRESETS,
  BackgroundPresetId,
  BackgroundState,
  DEFAULT_BACKGROUND_STATE,
  applyBackgroundState,
  readBackgroundCache,
  presetDisplayImage,
  writeBackgroundCache,
} from "@/lib/backgroundImage";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/ThemeProvider";
import { useUserSettings } from "@/lib/UserSettingsContext";

type Props = {
  tier: "free" | "scholar" | "researcher";
};

export function AppearanceSection({ tier }: Props) {
  const entitled = tier === "scholar" || tier === "researcher";
  const { userId } = useAuth();
  const { resolvedTheme } = useTheme();
  const { backgroundPreset, backgroundOpacity, loaded, refresh } = useUserSettings();

  const [state, setState] = useState<BackgroundState>(DEFAULT_BACKGROUND_STATE);

  useEffect(() => {
    if (!userId) return;
    setState(readBackgroundCache(userId));
  }, [userId]);

  useEffect(() => {
    if (!userId || !loaded) return;
    if (backgroundPreset == null && backgroundOpacity == null) return;
    const cached = readBackgroundCache(userId);
    const presetId = (backgroundPreset as BackgroundPresetId) || cached.presetId;
    const next: BackgroundState = {
      presetId: presetId === "custom" ? cached.presetId : presetId,
      customImage: presetId === "custom" ? cached.customImage : null,
      opacity: typeof backgroundOpacity === "number" ? backgroundOpacity : cached.opacity,
    };
    setState(next);
    writeBackgroundCache(next, userId);
    applyBackgroundState(next, resolvedTheme === "dark");
  }, [userId, loaded, backgroundPreset, backgroundOpacity, resolvedTheme]);

  const persist = useCallback(
    async (next: BackgroundState) => {
      if (!userId) return;
      setState(next);
      writeBackgroundCache(next, userId);
      applyBackgroundState(next, resolvedTheme === "dark");
      if (!entitled) return;
      try {
        await api.updateSettings({
          background_preset: next.presetId,
          background_opacity: next.opacity,
        });
        await refresh();
      } catch {
        /* local cache still applied */
      }
    },
    [userId, resolvedTheme, entitled, refresh],
  );

  const selectPreset = useCallback(
    (id: BackgroundPresetId) => {
      if (!entitled) return;
      void persist({ ...state, presetId: id, customImage: null });
    },
    [entitled, state, persist],
  );

  const setOpacity = useCallback(
    (value: number) => {
      void persist({ ...state, opacity: value });
    },
    [state, persist],
  );

  const resetAll = useCallback(() => {
    void persist(DEFAULT_BACKGROUND_STATE);
  }, [persist]);

  const visiblePresets = BACKGROUND_PRESETS.filter((p) => p.id !== "custom");

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
            Choose a curated background for your dashboard and library.
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
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {visiblePresets.map((p) => {
              const active = state.presetId === p.id;
              const swatchImage = presetDisplayImage(p, resolvedTheme === "dark");
              const swatchStyle: React.CSSProperties =
                p.id === "none"
                  ? { background: "var(--background)" }
                  : {
                      backgroundImage: swatchImage,
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
          </div>

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
