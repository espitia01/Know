"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/lib/api";
import {
  applyBackgroundState,
  type BackgroundPresetId,
  type BackgroundState,
  readBackgroundCache,
  writeBackgroundCache,
} from "@/lib/backgroundImage";
import { useTheme } from "@/lib/ThemeProvider";

const DEFAULT_ANALYSIS_MODEL = "mistral-small-latest";
const DEFAULT_FAST_MODEL = "mistral-small-latest";

export type UserSettings = {
  analysisModel: string;
  fastModel: string;
  hasAnthropicKey: boolean;
  allowedModels: string[];
  backgroundPreset?: string | null;
  backgroundOpacity?: number | null;
  loaded: boolean;
};

type UserSettingsContextValue = UserSettings & {
  refresh: () => Promise<void>;
  updateOptimistically: (patch: Partial<Pick<UserSettings, "analysisModel" | "fastModel">>) => void;
};

const defaultSettings: UserSettings = {
  analysisModel: DEFAULT_ANALYSIS_MODEL,
  fastModel: DEFAULT_FAST_MODEL,
  hasAnthropicKey: true,
  allowedModels: [],
  loaded: false,
};

const UserSettingsContext = createContext<UserSettingsContextValue>({
  ...defaultSettings,
  refresh: async () => {},
  updateOptimistically: () => {},
});

export function UserSettingsProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded, userId } = useAuth();
  const { resolvedTheme } = useTheme();
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const fetchedForRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isLoaded || !isSignedIn || !userId) {
      setSettings({ ...defaultSettings, loaded: true });
      return;
    }
    try {
      const [prefs, modelsRes] = await Promise.all([api.getSettings(), api.getModels()]);
      const allowed = modelsRes.models ?? [];
      setSettings({
        analysisModel: prefs.analysis_model || DEFAULT_ANALYSIS_MODEL,
        fastModel: prefs.fast_model || DEFAULT_FAST_MODEL,
        hasAnthropicKey: prefs.has_anthropic_key,
        allowedModels: allowed,
        backgroundPreset: prefs.background_preset ?? null,
        backgroundOpacity: prefs.background_opacity ?? null,
        loaded: true,
      });

      if (prefs.background_preset != null || prefs.background_opacity != null) {
        const cached = readBackgroundCache(userId);
        const presetId = (prefs.background_preset as BackgroundPresetId) || cached.presetId;
        const next: BackgroundState = {
          presetId: presetId === "custom" ? cached.presetId : presetId,
          customImage: presetId === "custom" ? cached.customImage : null,
          opacity:
            typeof prefs.background_opacity === "number"
              ? prefs.background_opacity
              : cached.opacity,
        };
        writeBackgroundCache(next, userId);
        applyBackgroundState(next, resolvedTheme === "dark");
      }
    } catch {
      setSettings((s) => ({ ...s, loaded: true }));
    }
  }, [isLoaded, isSignedIn, userId, resolvedTheme]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn || !userId) {
      fetchedForRef.current = null;
      setSettings({ ...defaultSettings, loaded: true });
      return;
    }
    if (fetchedForRef.current === userId) return;
    fetchedForRef.current = userId;
    void refresh();
  }, [isLoaded, isSignedIn, userId, refresh]);

  const updateOptimistically = useCallback(
    (patch: Partial<Pick<UserSettings, "analysisModel" | "fastModel">>) => {
      setSettings((s) => ({ ...s, ...patch }));
    },
    [],
  );

  // Memoize so consumers don't re-render on every parent render. Without
  // this, every component reading `useUserSettings()` (the paper page,
  // SummaryPanel, FiguresPanel, useSummaryStream, useSelectionThread, …)
  // got a new context object each render and tore down/re-created their
  // own callbacks — which manifested as a multi-second freeze the moment
  // the parent re-rendered (e.g. after closing the settings page).
  const value = useMemo<UserSettingsContextValue>(
    () => ({ ...settings, refresh, updateOptimistically }),
    [settings, refresh, updateOptimistically],
  );

  return <UserSettingsContext.Provider value={value}>{children}</UserSettingsContext.Provider>;
}

export function useUserSettings(): UserSettingsContextValue {
  return useContext(UserSettingsContext);
}
