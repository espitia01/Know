"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, SettingsResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthGuard } from "@/components/AuthGuard";

function SettingsContent() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setLocalUrl(s.local_model_url);
      setLocalModel(s.local_model_name);
    });
  }, []);

  const handleSave = async (provider?: string) => {
    setSaving(true);
    setSaved(false);
    try {
      const update: Record<string, string> = {};
      if (apiKey) update.anthropic_api_key = apiKey;
      if (localUrl) update.local_model_url = localUrl;
      if (localModel) update.local_model_name = localModel;
      if (provider) update.active_provider = provider;
      const result = await api.updateSettings(update);
      setSettings(result);
      setApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error("Settings save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex-1 flex flex-col items-center p-6 pt-[10vh]">
      <div className="max-w-md w-full space-y-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="text-muted-foreground hover:text-foreground transition-colors text-[13px] font-medium"
          >
            &larr; Back
          </button>
          <div className="h-4 w-px bg-border" />
          <h1 className="text-[15px] font-semibold">Settings</h1>
        </div>

        <div className="space-y-5 rounded-xl border p-5">
          <div className="flex items-center justify-between">
            <p className="text-[14px] font-semibold">Anthropic (Claude)</p>
            {settings?.active_provider === "anthropic" && (
              <span className="text-[10px] uppercase tracking-wider text-foreground bg-foreground/10 px-2 py-0.5 rounded-full font-semibold">
                Active
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground font-medium">API Key</label>
            <Input
              type="password"
              placeholder={settings?.has_anthropic_key ? "Key set (enter new to replace)" : "sk-ant-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="text-[13px] h-9"
            />
          </div>
          <Button
            size="sm"
            onClick={() => handleSave("anthropic")}
            disabled={saving}
            className="text-[13px] h-8 px-4"
          >
            {settings?.active_provider === "anthropic" ? "Save" : "Save & Activate"}
          </Button>
        </div>

        <div className="space-y-5 rounded-xl border p-5">
          <div className="flex items-center justify-between">
            <p className="text-[14px] font-semibold">Local Model</p>
            {settings?.active_provider === "local" && (
              <span className="text-[10px] uppercase tracking-wider text-foreground bg-foreground/10 px-2 py-0.5 rounded-full font-semibold">
                Active
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground font-medium">Base URL</label>
            <Input
              placeholder="http://localhost:11434/v1"
              value={localUrl}
              onChange={(e) => setLocalUrl(e.target.value)}
              className="text-[13px] h-9"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] text-muted-foreground font-medium">Model Name</label>
            <Input
              placeholder="llama3"
              value={localModel}
              onChange={(e) => setLocalModel(e.target.value)}
              className="text-[13px] h-9"
            />
          </div>
          <Button
            size="sm"
            onClick={() => handleSave("local")}
            disabled={saving}
            className="text-[13px] h-8 px-4"
          >
            {settings?.active_provider === "local" ? "Save" : "Save & Activate"}
          </Button>
        </div>

        {saved && (
          <p className="text-[13px] text-center text-foreground/60 animate-fade-in">Saved.</p>
        )}

        <div className="text-[12px] text-muted-foreground/60 space-y-1.5 border-t pt-5">
          <p>Or set environment variables in <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded">backend/.env</code>:</p>
          <pre className="bg-accent p-3 rounded-lg text-[11px] leading-relaxed text-muted-foreground">
{`KNOW_ANTHROPIC_API_KEY=sk-ant-...
KNOW_LOCAL_MODEL_URL=http://localhost:11434/v1
KNOW_LOCAL_MODEL_NAME=llama3
KNOW_ACTIVE_PROVIDER=anthropic`}
          </pre>
        </div>
      </div>
    </main>
  );
}

export default function SettingsPage() {
  return <AuthGuard><SettingsContent /></AuthGuard>;
}
