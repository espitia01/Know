"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useClerk, UserButton } from "@clerk/nextjs";
import { api, clearAuthState } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useUserTier } from "@/lib/UserTierContext";
import { useUserSettings } from "@/lib/UserSettingsContext";
import { useStore } from "@/lib/store";
import { CancelModal } from "@/components/CancelModal";
import { FeedbackModal } from "@/components/FeedbackModal";
import { UpgradeModal } from "@/components/UpgradeModal";
import { UpgradeConfirmModal } from "@/components/UpgradeConfirmModal";
import { UpgradeScheduledModal } from "@/components/UpgradeScheduledModal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AppearanceSection } from "@/components/AppearanceSection";
import { ModelPicker } from "@/components/settings/ModelPicker";
import { PlanUsage, type AccountUsage } from "@/components/settings/PlanUsage";
import { DISCORD_URL } from "@/lib/constants";
import { goToPricing, startCheckout } from "@/lib/checkout";

const DEFAULT_MODEL = "mistral-small-latest";

function formatLimit(value: unknown): string {
  if (value === -1) return "Unlimited";
  if (typeof value === "number") return String(value);
  return "—";
}

function formatDeepLimit(value: unknown, mult: number): string {
  if (value === -1) return "Unlimited";
  if (typeof value === "number" && value > 0) return String(Math.floor(value / mult));
  return "—";
}

function SettingsContent() {
  const router = useRouter();
  const { signOut } = useClerk();
  const { user: tierUser, refresh: refreshTier } = useUserTier();
  const { refresh: refreshUserSettings, updateOptimistically, loaded: settingsLoaded, analysisModel: ctxAnalysis, fastModel: ctxFast, allowedModels, hasAnthropicKey: ctxAnthropic } = useUserSettings();
  const [models, setModels] = useState<string[]>([]);
  const [analysisModel, setAnalysisModel] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [deepAnalysis, setDeepAnalysis] = useState(false);
  const [deepAllowed, setDeepAllowed] = useState(false);
  const [deepMultiplier, setDeepMultiplier] = useState(2);
  const [tierLimits, setTierLimits] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState("");
  const [billingLoading, setBillingLoading] = useState(false);
  const [resubscribeLoading, setResubscribeLoading] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [planChangeTarget, setPlanChangeTarget] = useState<"scholar" | "researcher" | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [scheduledUpgradeAt, setScheduledUpgradeAt] = useState<number | null>(null);
  const [scheduledTierLabel, setScheduledTierLabel] = useState("Researcher");
  const [showScheduledModal, setShowScheduledModal] = useState(false);
  const [hasAnthropicKey, setHasAnthropicKey] = useState<boolean | null>(null);
  const [hasOpenaiKey, setHasOpenaiKey] = useState<boolean | null>(null);
  const [hasMistralKey, setHasMistralKey] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<AccountUsage | null>(null);

  const tier = tierUser?.tier || "free";
  const usageRefreshKey = useStore((s) => s.usageRefreshKey);
  const userId = tierUser?.user_id ?? null;

  useEffect(() => {
    if (!settingsLoaded) return;
    setHasAnthropicKey(ctxAnthropic);
    if (ctxAnalysis) setAnalysisModel(ctxAnalysis);
    if (ctxFast) setFastModel(ctxFast);
    if (allowedModels.length) {
      setModels(allowedModels);
      setLoading(false);
    }
  }, [settingsLoaded, ctxAnthropic, ctxAnalysis, ctxFast, allowedModels]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const loadPrefs = async () => {
      try {
        const [settingsRes, modelsRes] = await Promise.all([
          api.getSettings(),
          allowedModels.length ? Promise.resolve({ models: allowedModels }) : api.getModels(),
        ]);
        if (cancelled) return;
        setHasAnthropicKey(Boolean(settingsRes.has_anthropic_key));
        setHasOpenaiKey(Boolean(settingsRes.has_openai_key));
        setHasMistralKey(Boolean(settingsRes.has_mistral_key));
        setAnalysisModel(settingsRes.analysis_model || DEFAULT_MODEL);
        setFastModel(settingsRes.fast_model || DEFAULT_MODEL);
        setDeepAnalysis(!!settingsRes.deep_analysis_enabled);
        setDeepAllowed(!!settingsRes.deep_analysis_allowed);
        setDeepMultiplier(settingsRes.deep_multiplier ?? 2);
        setTierLimits((settingsRes.tier_limits as Record<string, unknown>) ?? null);
        setModels(modelsRes.models);
        setLoadError("");
      } catch {
        if (!cancelled) setLoadError("Failed to load settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadPrefs();
    return () => {
      cancelled = true;
    };
    // Prefs are per user. Don't refetch when the tier object identity changes
    // (tab focus), which previously flashed the models skeleton.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- userId is the load key
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    api.getAccountUsage()
      .then((usageRes) => {
        if (!cancelled) setUsage(usageRes);
      })
      .catch(() => {
        /* usage is optional chrome */
      });
    return () => {
      cancelled = true;
    };
  }, [userId, usageRefreshKey]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const update: Record<string, string | boolean> = {};
      if (analysisModel) update.analysis_model = analysisModel;
      if (fastModel) update.fast_model = fastModel;
      if (deepAllowed) update.deep_analysis_enabled = deepAnalysis;
      const result = await api.updateSettings(update);
      setAnalysisModel(result.analysis_model);
      setFastModel(result.fast_model);
      setDeepAnalysis(!!result.deep_analysis_enabled);
      updateOptimistically({
        analysisModel: result.analysis_model,
        fastModel: result.fast_model,
      });
      await refreshUserSettings();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const providerKeys = {
    anthropic: !!hasAnthropicKey,
    openai: !!hasOpenaiKey,
    mistral: !!hasMistralKey,
  };

  return (
    <main className="flex-1 flex flex-col items-center px-6 pt-[8vh] pb-16 bg-mesh min-h-screen text-foreground">
      <div className="max-w-xl w-full space-y-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="text-muted-foreground hover:text-foreground motion-safe:duration-150 text-[13px] font-medium ring-focus rounded-md px-1"
          >
            &larr; Back
          </button>
          <div className="h-4 w-px bg-border" />
          <Image src="/logo.png" alt="Know" width={20} height={20} className="rounded-md" />
          <h1 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-foreground">
            Settings
          </h1>
          <div className="flex-1" />
          <ThemeToggle />
          <UserButton appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }} />
        </div>

        {/* Plan & usage */}
        <section className="space-y-4">
          <div>
            <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-foreground">
              Plan
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Your subscription, quotas, and billing.
            </p>
          </div>
          <div className="rounded-xl border border-border/50 bg-card/30 dark:bg-card/22 p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[14px] font-medium capitalize text-foreground">
                  {tier} plan
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  {tierUser?.paper_count ?? 0} paper{(tierUser?.paper_count ?? 0) === 1 ? "" : "s"} in library
                  {tierUser?.period_end
                    ? ` · Renews ${new Date(tierUser.period_end * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                    : ""}
                </p>
              </div>
              {tier === "free" && (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    disabled={billingLoading}
                    onClick={async () => {
                      setBillingError("");
                      setBillingLoading(true);
                      try {
                        window.location.href = await startCheckout("scholar");
                      } catch (e: unknown) {
                        setBillingError(e instanceof Error ? e.message : "Checkout failed.");
                        setBillingLoading(false);
                      }
                    }}
                    className="shrink-0 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background motion-safe:duration-150 hover:opacity-90 disabled:opacity-50"
                  >
                    {billingLoading ? "Redirecting…" : "Upgrade"}
                  </button>
                  {billingError && (
                    <p className="max-w-[12rem] text-right text-[11px] text-destructive">{billingError}</p>
                  )}
                </div>
              )}
              {tier === "scholar" && (
                <button
                  onClick={() => { setBillingError(""); setPlanChangeTarget("researcher"); }}
                  className="shrink-0 rounded-lg bg-foreground px-3 py-1.5 text-[12px] font-medium text-background motion-safe:duration-150 hover:opacity-90"
                >
                  Upgrade
                </button>
              )}
              {tier === "researcher" && (
                <button
                  onClick={() => { setBillingError(""); setPlanChangeTarget("scholar"); }}
                  className="shrink-0 text-[12px] font-medium text-muted-foreground hover:text-foreground motion-safe:duration-150"
                >
                  Switch to Scholar
                </button>
              )}
            </div>

            {tierUser?.past_due && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
                <p className="text-[12px] font-medium text-warning">Payment needs attention</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Update your card in billing to keep your plan.
                </p>
              </div>
            )}

            {tierUser?.cancel_at_period_end && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
                <p className="text-[12px] font-medium text-warning">Cancellation scheduled</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Access continues until{" "}
                  {tierUser.cancel_at
                    ? new Date(tierUser.cancel_at * 1000).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "the end of this billing period"}
                  .
                </p>
              </div>
            )}

            {usage && !loading && (
              <div className="border-t border-border/40 pt-5">
                <PlanUsage usage={usage} periodEnd={tierUser?.period_end} />
              </div>
            )}

            {tierUser?.has_billing && tierUser.tier !== "free" && (
              <div className="flex flex-col gap-2 border-t border-border/40 pt-4">
                <button
                  onClick={async () => {
                    setBillingLoading(true);
                    setBillingError("");
                    try {
                      const { url } = await api.createPortalSession(window.location.href);
                      if (url) window.location.href = url;
                    } catch (e: unknown) {
                      setBillingError(e instanceof Error ? e.message : "Could not open billing portal");
                    } finally {
                      setBillingLoading(false);
                    }
                  }}
                  disabled={billingLoading}
                  className="w-full rounded-lg border border-border/50 bg-background px-3 py-2.5 text-[13px] font-medium text-foreground hover:bg-accent/50 motion-safe:duration-150 disabled:opacity-50"
                >
                  {billingLoading ? "Opening…" : "Manage billing"}
                </button>
                {tierUser.cancel_at_period_end ? (
                  <button
                    onClick={async () => {
                      setResubscribeLoading(true);
                      setBillingError("");
                      try {
                        await api.resubscribe();
                        await refreshTier();
                      } catch (e: unknown) {
                        setBillingError(e instanceof Error ? e.message : "Could not resubscribe");
                      } finally {
                        setResubscribeLoading(false);
                      }
                    }}
                    disabled={resubscribeLoading}
                    className="w-full rounded-lg bg-foreground px-3 py-2.5 text-[13px] font-medium text-background hover:opacity-90 motion-safe:duration-150 disabled:opacity-50"
                  >
                    {resubscribeLoading ? "Resuming…" : "Resume subscription"}
                  </button>
                ) : (
                  <button
                    onClick={() => { setBillingError(""); setShowCancelModal(true); }}
                    className="w-full rounded-lg px-3 py-2 text-[12px] font-medium text-muted-foreground hover:text-destructive motion-safe:duration-150"
                  >
                    Cancel subscription
                  </button>
                )}
                {billingError && (
                  <p className="text-[12px] text-destructive text-center">{billingError}</p>
                )}
              </div>
            )}

            {tier !== "researcher" && !tierUser?.has_billing && (
              <button
                type="button"
                onClick={goToPricing}
                className="text-[12px] font-medium text-muted-foreground hover:text-foreground motion-safe:duration-150"
              >
                Compare plans →
              </button>
            )}
          </div>
        </section>

        {/* Models */}
        <section className="space-y-4">
          <div>
            <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-foreground">
              Models
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Choose defaults for long-form analysis and selection work.
            </p>
          </div>
          <div className="rounded-xl border border-border/50 bg-card/30 dark:bg-card/22 p-5 space-y-6">
            {loadError && <p className="text-[12px] text-destructive">{loadError}</p>}
            {loading ? (
              <div className="space-y-3 animate-pulse">
                <div className="h-10 rounded-lg bg-muted/[0.08]" />
                <div className="h-10 rounded-lg bg-muted/[0.08]" />
              </div>
            ) : (
              <>
                <ModelPicker
                  label="Analysis"
                  hint="Prepare, Summary, Assumptions, and Q&A"
                  name="analysis_model"
                  value={analysisModel}
                  allowedIds={models}
                  keys={providerKeys}
                  onChange={setAnalysisModel}
                />
                <ModelPicker
                  label="Selection"
                  hint="Explain, Derive, Figures, and follow-ups"
                  name="fast_model"
                  value={fastModel}
                  allowedIds={models}
                  keys={providerKeys}
                  onChange={setFastModel}
                />
              </>
            )}

            {tier !== "free" && (
              <div className="space-y-3 border-t border-border/40 pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-foreground">Deep analysis</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                      2× prompt budget so more of the paper reaches the model. Each call uses 2× quota.
                    </p>
                  </div>
                  <label className={`mt-0.5 inline-flex items-center ${!deepAllowed ? "opacity-50" : ""}`}>
                    <input
                      type="checkbox"
                      checked={deepAnalysis}
                      disabled={!deepAllowed}
                      onChange={(e) => setDeepAnalysis(e.target.checked)}
                      className="accent-foreground h-4 w-4"
                    />
                    <span className="sr-only">Enable deep analysis</span>
                  </label>
                </div>
                {tierLimits && deepAllowed && (
                  <p className="text-[11px] text-muted-foreground">
                    Standard: {formatLimit(tierLimits.qa_per_paper)} Q&amp;A and {formatLimit(tierLimits.selections_per_paper)} selections per paper.
                    Deep: {formatDeepLimit(tierLimits.qa_per_paper, deepMultiplier)} Q&amp;A and {formatDeepLimit(tierLimits.selections_per_paper, deepMultiplier)} selections.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <Button
                onClick={handleSave}
                disabled={saving || loading}
                className="h-9 rounded-lg bg-foreground px-4 text-[13px] font-medium text-background hover:opacity-90 border-0"
              >
                {saving ? "Saving…" : "Save models"}
              </Button>
              {saved && <p className="text-[12px] text-muted-foreground">Saved</p>}
              {saveError && <p className="text-[12px] text-destructive">{saveError}</p>}
            </div>
          </div>
        </section>

        <AppearanceSection tier={tier} />

        <section className="space-y-3">
          <h2 className="font-display text-[15px] font-semibold tracking-[-0.02em] text-foreground">
            Account
          </h2>
          <button
            onClick={() => {
              try { useStore.getState().clearSession(); } catch { /* no-op */ }
              clearAuthState();
              signOut({ redirectUrl: "/" });
            }}
            className="w-full rounded-xl border border-border/50 bg-card/30 dark:bg-card/22 px-4 py-3 text-[13px] font-medium text-muted-foreground hover:text-destructive hover:border-destructive/40 motion-safe:duration-150"
          >
            Sign out
          </button>
        </section>

        <div className="flex items-center justify-center gap-8 pt-2 pb-4">
          <button
            onClick={() => setShowFeedback(true)}
            className="text-[12px] text-muted-foreground hover:text-foreground/90 motion-safe:duration-150 font-medium"
          >
            Feedback
          </button>
          <Link
            href="/terms"
            className="text-[12px] text-muted-foreground hover:text-foreground/90 motion-safe:duration-150 font-medium"
          >
            Terms
          </Link>
          <a
            href={DISCORD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] text-muted-foreground hover:text-foreground/90 motion-safe:duration-150 font-medium"
          >
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
      <UpgradeConfirmModal
        tier={planChangeTarget ?? "researcher"}
        tierLabel={planChangeTarget === "scholar" ? "Scholar" : "Researcher"}
        open={planChangeTarget !== null}
        onClose={() => setPlanChangeTarget(null)}
        onUpgraded={async (mode, preview) => {
          const next = planChangeTarget;
          setPlanChangeTarget(null);
          await refreshTier();
          if (mode === "now") {
            if (next === "researcher") setShowUpgradeModal(true);
          } else {
            setScheduledTierLabel(next === "scholar" ? "Scholar" : "Researcher");
            setScheduledUpgradeAt(preview?.period_end ?? null);
            setShowScheduledModal(true);
          }
        }}
      />
      <UpgradeModal
        tier="researcher"
        open={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
      />
      <UpgradeScheduledModal
        tierLabel={scheduledTierLabel}
        effectiveAt={scheduledUpgradeAt}
        open={showScheduledModal}
        onClose={() => setShowScheduledModal(false)}
      />
    </main>
  );
}

export default function SettingsPage() {
  return <SettingsContent />;
}
