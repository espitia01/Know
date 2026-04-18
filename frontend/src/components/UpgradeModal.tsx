"use client";

const TIER_UNLOCKS: Record<string, { title: string; features: string[] }> = {
  scholar: {
    title: "Scholar Plan",
    features: [
      "25 papers — room for a full research project",
      "Pre-Reading Prep — AI extracts concepts & definitions before you read",
      "Assumption Analysis — uncover hidden assumptions in any paper",
      "Unlimited Q&A — ask as many questions as you want",
      "Unlimited Selections — highlight and analyze any passage",
      "Figure Analysis — AI-powered visual analysis of every figure",
      "Smart Notes — save highlights, explanations, and derivations",
      "Haiku + Sonnet models — choose speed or depth",
    ],
  },
  researcher: {
    title: "Researcher Plan",
    features: [
      "Unlimited papers — no cap on your library",
      "Cross-Paper Sessions — compare and synthesize across papers",
      "Claude Opus — the most powerful model for the deepest analysis",
      "Everything in Scholar — all features, no limits",
    ],
  },
};

interface UpgradeModalProps {
  tier: string;
  open: boolean;
  onClose: () => void;
}

export function UpgradeModal({ tier, open, onClose }: UpgradeModalProps) {
  const info = TIER_UNLOCKS[tier];

  if (!open || !info) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-gray-100 max-w-md w-full mx-4 overflow-hidden animate-fade-in">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 z-10"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="bg-gray-50/80 px-6 pt-8 pb-5 text-center border-b border-gray-100">
          <div className="w-12 h-12 rounded-xl bg-white border border-gray-100 flex items-center justify-center mx-auto mb-4 shadow-sm">
            <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
            </svg>
          </div>
          <h2 className="text-[18px] font-bold tracking-[-0.02em] text-gray-900">Welcome to {info.title}</h2>
          <p className="text-[13px] text-gray-500 mt-1.5">
            Here&apos;s what you&apos;ve unlocked
          </p>
        </div>

        <div className="px-6 py-6">
          <ul className="space-y-3">
            {info.features.map((feat) => (
              <li key={feat} className="flex items-start gap-3 text-[13px] text-gray-600">
                <svg className="w-4 h-4 mt-0.5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                <span>{feat}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="px-6 pb-6">
          <button
            onClick={onClose}
            className="w-full text-[13px] font-semibold py-3 rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors shadow-sm shadow-gray-900/10"
          >
            Start exploring
          </button>
        </div>
      </div>
    </div>
  );
}
