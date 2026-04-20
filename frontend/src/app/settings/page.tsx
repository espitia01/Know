"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useClerk, UserButton } from "@clerk/nextjs";
import { api, SettingsResponse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useUserTier } from "@/lib/UserTierContext";
import { CancelModal } from "@/components/CancelModal";
import { FeedbackModal } from "@/components/FeedbackModal";
import { UpgradeModal } from "@/components/UpgradeModal";

const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Fastest — great for quick explanations",
  "claude-sonnet-4-6": "Balanced — speed and quality",
  "claude-opus-4": "Highest quality — deepest analysis",
};

function UsageBar({ label, used, limit, hint }: { label: string; used: number; limit: number; hint?: string }) {
  const unlimited = limit === -1;
  const pct = unlimited ? 0 : Math.min(100, limit > 0 ? (used / limit) * 100 : 0);
  const nearLimit = !unlimited && pct >= 80;
  const over = !unlimited && used >= limit;
  return (
    <div className="space-y-1.5" title={hint}>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-gray-600 font-medium">{label}</span>
        <span className="tabular-nums text-gray-500">
          {unlimited ? (
            <span className="font-medium text-gray-700">{used} <span className="text-gray-400">/ Unlimited</span></span>
          ) : (
            <span className={`font-medium ${over ? "text-red-500" : nearLimit ? "text-amber-600" : "text-gray-700"}`}>
              {used} / {limit}
            </span>
          )}
        </span>
      </div>
      <div className="w-full h-1.5 bg-black/[0.05] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            unlimited ? "bg-gray-300" : over ? "bg-red-400" : nearLimit ? "bg-amber-400" : "bg-gray-700"
          }`}
          style={{ width: unlimited ? "8%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SettingsContent() {
  const router = useRouter();
  const { signOut } = useClerk();
  const { user: tierUser, refresh: refreshTier } = useUserTier();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [analysisModel, setAnalysisModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [billingLoading, setBillingLoading] = useState(false);
  const [resubscribeLoading, setResubscribeLoading] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [usage, setUsage] = useState<{
    tier: string;
    papers_used: number;
    papers_limit: number;
    daily_api_used: number;
    daily_api_limit: number;
    qa_per_paper_limit: number;
    selections_per_paper_limit: number;
  } | null>(null);

  const tier = tierUser?.tier || "free";
  const showModels = tier !== "free";

  useEffect(() => {
    if (showModels) {
      api.getSettings().then((s) => {
        setSettings(s);
        setAnalysisModel(s.analysis_model);
        setFastModel(s.fast_model);
      }).catch(() => setLoadError("Failed to load settings."));
      api.getModels().then((r) => setModels(r.models)).catch(() => {});
    }
  }, [showModels]);

  useEffect(() => {
    if (tierUser) {
      api.getAccountUsage().then(setUsage).catch(() => {});
    }
  }, [tierUser]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const update: Record<string, string> = {};
      if (analysisModel) update.analysis_model = analysisModel;
      if (fastModel) update.fast_model = fastModel;
      const result = await api.updateSettings(update);
      setSettings(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex-1 flex flex-col items-center px-6 pt-[8vh] pb-12 bg-mesh min-h-screen">
      <div className="max-w-lg w-full space-y-8">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="text-gray-500 hover:text-gray-700 transition-colors text-[13px] font-medium"
          >
            &larr; Back
          </button>
          <div className="h-4 w-px bg-black/[0.06]" />
          <Image src="/logo.png" alt="Know" width={20} height={20} className="rounded-md" />
          <h1 className="text-[15px] font-semibold text-gray-900">Settings</h1>
          <div className="flex-1" />
          <UserButton appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }} />
        </div>

        {/* Model Selection */}
        {showModels && (
          <div className="space-y-5">
            <div className="glass rounded-2xl p-6 space-y-5">
              <div className="flex items-center justify-between">
                <p className="text-[14px] font-semibold text-gray-900">Models</p>
                <span className="text-[11px] text-gray-500 glass-subtle px-2.5 py-1 rounded-full font-medium capitalize">
                  {tier} Plan
                </span>
              </div>

              {loadError && (
                <p className="text-[12px] text-red-500">{loadError}</p>
              )}

              <div className="space-y-2">
                <label className="text-[12px] text-gray-600 font-medium">
                  Analysis Model
                  <span className="text-gray-300 ml-1 font-normal">(Prepare, Assumptions, Q&A)</span>
                </label>
                <div className="space-y-1.5">
                  {models.map((m) => (
                    <label
                      key={m}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
                        analysisModel === m
                          ? "glass-strong shadow-sm"
                          : "glass-subtle hover:bg-white/60"
                      }`}
                    >
                      <input
                        type="radio"
                        name="analysis_model"
                        value={m}
                        checked={analysisModel === m}
                        onChange={() => setAnalysisModel(m)}
                        className="accent-gray-900"
                      />
                      <div>
                        <p className="text-[13px] font-medium text-gray-800">{m}</p>
                        <p className="text-[11px] text-gray-400">{MODEL_LABELS[m] || ""}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2 pt-4 border-t border-black/[0.06]">
                <label className="text-[12px] text-gray-600 font-medium">
                  Selection Model
                  <span className="text-gray-300 ml-1 font-normal">(Explain, Derive)</span>
                </label>
                <div className="space-y-1.5">
                  {models.map((m) => (
                    <label
                      key={m}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
                        fastModel === m
                          ? "glass-strong shadow-sm"
                          : "glass-subtle hover:bg-white/60"
                      }`}
                    >
                      <input
                        type="radio"
                        name="fast_model"
                        value={m}
                        checked={fastModel === m}
                        onChange={() => setFastModel(m)}
                        className="accent-gray-900"
                      />
                      <div>
                        <p className="text-[13px] font-medium text-gray-800">{m}</p>
                        <p className="text-[11px] text-gray-400">{MODEL_LABELS[m] || ""}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {tier !== "researcher" && (
                <p className="text-[11px] text-gray-400 text-center pt-2">
                  Upgrade to Researcher to unlock Opus.{" "}
                  <button onClick={() => router.push("/#pricing")} className="underline hover:text-gray-600 transition-colors">
                    View plans
                  </button>
                </p>
              )}
            </div>

            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full text-[13px] h-10 rounded-xl btn-primary-glass border-0"
            >
              {saving ? "Saving..." : "Save Settings"}
            </Button>

            {saved && (
              <p className="text-[13px] text-center text-gray-400 animate-fade-in">Saved.</p>
            )}
            {saveError && (
              <p className="text-[12px] text-center text-red-500">{saveError}</p>
            )}
          </div>
        )}

        {/* Usage */}
        {usage && (
          <div className="glass rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-[14px] font-semibold text-gray-900">Usage</p>
              <span className="text-[11px] text-gray-500 glass-subtle px-2.5 py-1 rounded-full font-medium capitalize">
                {usage.tier} Plan
              </span>
            </div>

            <UsageBar
              label="Papers in library"
              used={usage.papers_used}
              limit={usage.papers_limit}
              hint="Total papers uploaded to your library."
            />
            <UsageBar
              label="API calls today"
              used={usage.daily_api_used}
              limit={usage.daily_api_limit}
              hint="Resets at midnight UTC. Counts all AI analyses."
            />

            <div className="pt-2 border-t border-black/[0.06] space-y-1.5 text-[11px] text-gray-500">
              <div className="flex items-center justify-between">
                <span>Q&amp;A per paper</span>
                <span className="font-medium text-gray-700 tabular-nums">
                  {usage.qa_per_paper_limit === -1 ? "Unlimited" : usage.qa_per_paper_limit}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Selections per paper</span>
                <span className="font-medium text-gray-700 tabular-nums">
                  {usage.selections_per_paper_limit === -1 ? "Unlimited" : usage.selections_per_paper_limit}
                </span>
              </div>
            </div>

            {tier !== "researcher" && (
              <button
                onClick={() => router.push("/#pricing")}
                className="w-full text-[12px] font-medium text-gray-600 hover:text-gray-900 transition-colors pt-1"
              >
                Need more? View plans &rarr;
              </button>
            )}
          </div>
        )}

        {/* Account */}
        <div className="glass rounded-2xl p-6 space-y-5">
          <p className="text-[14px] font-semibold text-gray-900">Account</p>

          {tierUser && (
            <div className="flex items-center justify-between px-4 py-3.5 rounded-xl glass-subtle">
              <div>
                <p className="text-[13px] font-medium text-gray-800 capitalize">{tierUser.tier} Plan</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {tierUser.paper_count} paper{tierUser.paper_count !== 1 ? "s" : ""} uploaded
                </p>
              </div>
              {tierUser.tier === "free" && (
                <button
                  onClick={() => router.push("/#pricing")}
                  className="text-[12px] font-semibold bg-gradient-to-r from-violet-500 to-purple-600 text-white px-4 py-2 rounded-xl hover:opacity-90 transition-all shadow-sm"
                >
                  Upgrade
                </button>
              )}
              {tierUser.tier === "scholar" && (
                <button
                  onClick={async () => {
                    setUpgradeLoading(true);
                    setBillingError("");
                    try {
                      await api.upgradeSubscription("researcher");
                      await refreshTier();
                      setShowUpgradeModal(true);
                    } catch (e: unknown) {
                      const msg = e instanceof Error ? e.message : "Upgrade failed";
                      setBillingError(msg);
                    } finally {
                      setUpgradeLoading(false);
                    }
                  }}
                  disabled={upgradeLoading}
                  className="text-[12px] font-semibold bg-gradient-to-r from-violet-500 to-purple-600 text-white px-4 py-2 rounded-xl hover:opacity-90 transition-all shadow-sm disabled:opacity-50"
                >
                  {upgradeLoading ? "Upgrading..." : "Upgrade to Researcher"}
                </button>
              )}
            </div>
          )}

          {tierUser?.has_billing && tierUser.tier !== "free" && (
            <div className="space-y-3">
              <button
                onClick={async () => {
                  setBillingLoading(true);
                  setBillingError("");
                  try {
                    const { url } = await api.createPortalSession(window.location.href);
                    if (url) window.location.href = url;
                  } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : "Could not open billing portal";
                    setBillingError(msg);
                  } finally {
                    setBillingLoading(false);
                  }
                }}
                disabled={billingLoading}
                className="w-full text-[13px] font-medium px-4 py-3 rounded-xl glass text-gray-700 hover:bg-white/60 transition-all disabled:opacity-50"
              >
                {billingLoading ? "Opening..." : "Manage Billing"}
              </button>

              {tierUser.cancel_at_period_end ? (
                <>
                  <div className="px-4 py-3.5 rounded-xl glass-subtle border-amber-200/40 text-center">
                    <p className="text-[13px] text-amber-800 font-medium">Cancellation scheduled</p>
                    <p className="text-[11px] text-amber-600 mt-0.5">
                      Access continues until{" "}
                      {tierUser.cancel_at
                        ? new Date(tierUser.cancel_at * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
                        : "end of billing period"}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      setResubscribeLoading(true);
                      setBillingError("");
                      try {
                        await api.resubscribe();
                        await refreshTier();
                      } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : "Could not resubscribe";
                        setBillingError(msg);
                      } finally {
                        setResubscribeLoading(false);
                      }
                    }}
                    disabled={resubscribeLoading}
                    className="w-full text-[13px] font-semibold px-4 py-3 rounded-xl btn-primary-glass text-white transition-all disabled:opacity-50"
                  >
                    {resubscribeLoading ? "Resubscribing..." : "Resubscribe"}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => { setBillingError(""); setShowCancelModal(true); }}
                  className="w-full text-[13px] font-medium px-4 py-3 rounded-xl glass border-red-200/40 text-red-500 hover:bg-red-50/30 transition-all"
                >
                  Cancel Subscription
                </button>
              )}

              {billingError && (
                <p className="text-[11px] text-red-500 text-center">{billingError}</p>
              )}
            </div>
          )}

          <button
            onClick={() => signOut({ redirectUrl: "/" })}
            className="w-full text-[13px] font-medium px-4 py-3 rounded-xl glass text-gray-600 hover:text-red-500 hover:border-red-200/40 hover:bg-red-50/30 transition-all"
          >
            Sign Out
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-center gap-8 pt-2 pb-4">
          <button
            onClick={() => setShowFeedback(true)}
            className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium"
          >
            Feedback
          </button>
          <Link
            href="/terms"
            className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium"
          >
            Terms
          </Link>
          <a
            href="https://discord.gg/BgNdPsVfDE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            Discord
          </a>
        </div>
      </div>

      <CancelModal
        tier={tier}
        open={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onCancelled={() => {
          setShowCancelModal(false);
          refreshTier();
        }}
      />
      <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} />
      <UpgradeModal
        tier="researcher"
        open={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
      />
    </main>
  );
}

export default function SettingsPage() {
  return <SettingsContent />;
}
