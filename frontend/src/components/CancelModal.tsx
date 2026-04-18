"use client";

import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";

const CANCEL_REASONS = [
  { id: "too_expensive", label: "Too expensive" },
  { id: "not_using", label: "I'm not using it enough" },
  { id: "missing_features", label: "Missing features I need" },
  { id: "found_alternative", label: "Found an alternative" },
  { id: "temporary", label: "Just need a break — I'll be back" },
  { id: "other", label: "Other" },
];

type Step = "confirm" | "reason" | "cancelling" | "done";

function getLosses(tier: string): string[] {
  if (tier === "researcher") {
    return [
      "Claude Opus — the most powerful model (back to Haiku only)",
      "Claude Sonnet — balanced speed and quality",
      "Cross-Paper Sessions for multi-paper synthesis",
      "Unlimited papers (drops to 3)",
      "All Scholar features (Prepare, Assumptions, Figures, Notes, etc.)",
      "Unlimited Q&A and selections",
    ];
  }
  return [
    "Claude Sonnet model (back to Haiku only)",
    "Pre-Reading Prep and Assumption Analysis",
    "Figure Analysis with AI vision",
    "Smart Notes on highlights",
    "Unlimited Q&A (drops to 5 per paper per day)",
    "Unlimited selections (drops to 3 per paper per day)",
    "Paper limit drops from 25 to 3",
  ];
}

interface CancelModalProps {
  tier: string;
  open: boolean;
  onClose: () => void;
  onCancelled: () => void;
}

export function CancelModal({ tier, open, onClose, onCancelled }: CancelModalProps) {
  const [step, setStep] = useState<Step>("confirm");
  const [selectedReason, setSelectedReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [cancelDate, setCancelDate] = useState("");
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep("confirm");
      setSelectedReason("");
      setFeedback("");
      setError("");
      setCancelDate("");
    }
    wasOpen.current = open;
  }, [open]);

  const losses = getLosses(tier);

  const handleCancel = async () => {
    setStep("cancelling");
    setError("");
    try {
      const result = await api.cancelSubscription(selectedReason, feedback);
      if (result.cancel_at) {
        setCancelDate(new Date(result.cancel_at * 1000).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        }));
      }
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Cancellation failed");
      setStep("reason");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={step !== "cancelling" ? onClose : undefined}
      />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-gray-100 max-w-md w-full mx-4 overflow-hidden animate-fade-in">

        {step === "confirm" && (
          <>
            <div className="px-6 pt-7 pb-4 text-center">
              <div className="w-11 h-11 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <h2 className="text-[17px] font-bold text-gray-900">Cancel your {tier} plan?</h2>
              <p className="text-[13px] text-gray-500 mt-1.5">
                You&apos;ll lose access to these features:
              </p>
            </div>

            <div className="px-6 pb-5">
              <ul className="space-y-2.5">
                {losses.map((loss) => (
                  <li key={loss} className="flex items-start gap-3 text-[13px] text-gray-600">
                    <svg className="w-4 h-4 mt-0.5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    <span>{loss}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="px-6 pb-6 flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 text-[13px] font-semibold py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors"
              >
                Keep my plan
              </button>
              <button
                onClick={() => setStep("reason")}
                className="flex-1 text-[13px] font-medium py-3 rounded-xl border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
              >
                Continue cancelling
              </button>
            </div>
          </>
        )}

        {step === "reason" && (
          <>
            <div className="px-6 pt-7 pb-4">
              <h2 className="text-[17px] font-bold text-gray-900">We&apos;re sorry to see you go</h2>
              <p className="text-[13px] text-gray-500 mt-1">
                Help us improve — why are you cancelling?
              </p>
            </div>

            <div className="px-6 pb-3 space-y-1.5">
              {CANCEL_REASONS.map((r) => (
                <label
                  key={r.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all duration-200 ${
                    selectedReason === r.id
                      ? "border-gray-300 bg-gray-50"
                      : "border-gray-100 hover:bg-gray-50/60"
                  }`}
                >
                  <input
                    type="radio"
                    name="cancel_reason"
                    value={r.id}
                    checked={selectedReason === r.id}
                    onChange={() => setSelectedReason(r.id)}
                    className="accent-gray-900"
                  />
                  <span className="text-[13px] text-gray-700">{r.label}</span>
                </label>
              ))}
            </div>

            {selectedReason && (
              <div className="px-6 pb-3 animate-fade-in">
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="Anything else you'd like to share? (optional)"
                  className="w-full text-[13px] border border-gray-100 rounded-xl px-4 py-3 resize-none h-20 focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-gray-300 placeholder:text-gray-400"
                />
              </div>
            )}

            {error && (
              <p className="px-6 pb-2 text-[12px] text-red-500">{error}</p>
            )}

            <div className="px-6 pb-6 flex gap-3">
              <button
                onClick={() => setStep("confirm")}
                className="flex-1 text-[13px] font-medium py-3 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Go back
              </button>
              <button
                onClick={handleCancel}
                disabled={!selectedReason}
                className="flex-1 text-[13px] font-medium py-3 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel subscription
              </button>
            </div>
          </>
        )}

        {step === "cancelling" && (
          <div className="px-6 py-14 text-center">
            <div className="w-7 h-7 border-2 border-gray-200 border-t-gray-600 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[13px] text-gray-500">Processing cancellation...</p>
          </div>
        )}

        {step === "done" && (
          <>
            <div className="px-6 pt-8 pb-4 text-center">
              <div className="w-11 h-11 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4">
                <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-[17px] font-bold text-gray-900">Subscription cancelled</h2>
              <p className="text-[13px] text-gray-500 mt-2 leading-relaxed">
                You&apos;ll keep full access until{" "}
                <span className="font-medium text-gray-800">{cancelDate || "the end of your billing period"}</span>.
                After that, you&apos;ll be moved to the Free plan.
              </p>
              <p className="text-[12px] text-gray-400 mt-2">
                You can resubscribe anytime from settings.
              </p>
            </div>
            <div className="px-6 pb-6">
              <button
                onClick={() => { onClose(); onCancelled(); }}
                className="w-full text-[13px] font-semibold py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors"
              >
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
