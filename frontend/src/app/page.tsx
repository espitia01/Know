"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { UserButton, useAuth } from "@clerk/nextjs";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import { api } from "@/lib/api";
import { FeedbackModal } from "@/components/FeedbackModal";

const DISCORD_URL = "https://discord.gg/BgNdPsVfDE";

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

const features = [
  {
    title: "AI Summary",
    desc: "Structured summaries covering motivation, methodology, results, and key equations.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
  {
    title: "Pre-Reading Prep",
    desc: "Key definitions, concepts, research questions, and prior work before you start reading.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
      </svg>
    ),
  },
  {
    title: "Assumption Analysis",
    desc: "Uncover implicit and explicit assumptions underlying methodology and conclusions.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
      </svg>
    ),
  },
  {
    title: "Interactive Q&A",
    desc: "Ask any question about the paper and get accurate, context-aware answers.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
    ),
  },
  {
    title: "Figure Analysis",
    desc: "Click any figure for AI-powered visual analysis with conversational follow-ups.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75A2.25 2.25 0 001.5 6.75v12a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    title: "Smart Notes",
    desc: "Highlight any passage to save notes, get explanations, or derive equations step by step.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
      </svg>
    ),
  },
];

const steps = [
  { num: "1", title: "Upload a PDF", desc: "Drag and drop any academic paper. arXiv, Nature, Science, or any journal." },
  { num: "2", title: "AI extracts understanding", desc: "Summaries, assumptions, key concepts, and figures are analyzed in seconds." },
  { num: "3", title: "Deep-dive interactively", desc: "Highlight text, ask questions, derive equations, and take smart notes." },
];

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    desc: "Get started with the basics.",
    cta: "Get Started",
    tier: "free",
    highlight: false,
    features: [
      "3 papers",
      "AI Summary",
      "5 Q&A per paper",
      "3 selections per paper",
      "Haiku model",
    ],
  },
  {
    name: "Scholar",
    price: "$10",
    period: "/mo",
    desc: "For serious students and researchers.",
    cta: "Upgrade to Scholar",
    tier: "scholar",
    highlight: true,
    features: [
      "25 papers",
      "AI Summary",
      "Pre-Reading Prep",
      "Assumption Analysis",
      "100 Q&A per paper",
      "100 selections per paper",
      "Figure Analysis",
      "Notes",
      "BibTeX export",
      "Haiku + Sonnet models",
    ],
  },
  {
    name: "Researcher",
    price: "$20",
    period: "/mo",
    desc: "Full power for intensive research.",
    cta: "Upgrade to Researcher",
    tier: "researcher",
    highlight: false,
    features: [
      "Unlimited papers",
      "Everything in Scholar",
      "Unlimited Q&A & selections",
      "Cross-Paper Sessions",
      "Opus model (priority)",
    ],
  },
];

export default function LandingPage() {
  const hero = useInView(0.1);
  const howItWorks = useInView(0.1);
  const featuresSection = useInView(0.1);
  const pricing = useInView(0.1);
  const { isSignedIn, isLoaded } = useAuth();
  const [showFeedback, setShowFeedback] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const handleTierClick = async (tier: string) => {
    if (tier === "free") {
      window.location.href = "/sign-up";
      return;
    }
    if (!isLoaded) return;
    if (!isSignedIn) {
      window.location.href = "/sign-up";
      return;
    }
    setCheckoutLoading(tier);
    try {
      const { url } = await api.createCheckoutSession(
        tier,
        `${window.location.origin}/dashboard?upgraded=1`,
        `${window.location.origin}/#pricing`
      );
      if (url) window.location.href = url;
    } catch {
      setCheckoutLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-mesh">
      {/* Nav */}
      <nav className="sticky top-0 z-50 glass-nav">
        <div className="max-w-6xl mx-auto px-6 h-[60px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.png" alt="Know" width={26} height={26} className="rounded-md" />
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-gray-900">Know</span>
          </Link>
          <div className="flex items-center gap-6">
            <div className="hidden sm:flex items-center gap-6 text-[13px] text-gray-600">
              <a href="#features" className="hover:text-gray-900 transition-colors">Features</a>
              <a href="#pricing" className="hover:text-gray-900 transition-colors">Pricing</a>
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="hover:text-gray-900 transition-colors">Discord</a>
            </div>
            {isLoaded && !isSignedIn && (
              <>
              <Link
                href="/sign-in"
                className="text-[13px] font-medium text-gray-600 hover:text-gray-900 transition-colors"
              >
                Sign in
              </Link>
              <Link
                href="/sign-up"
                className="text-[13px] font-medium btn-primary-glass text-white px-4 py-2 rounded-xl transition-all"
              >
                Get Started
              </Link>
              </>
            )}
            {isLoaded && isSignedIn && (
              <>
              <Link
                href="/dashboard"
                className="text-[13px] font-medium text-gray-600 hover:text-gray-900 transition-colors px-3 py-1.5"
              >
                Dashboard
              </Link>
              <UserButton appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }} />
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section
        ref={hero.ref}
        className={`relative pt-28 pb-24 px-6 overflow-hidden transition-all duration-1000 ${hero.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
      >
        <div className="absolute inset-0 bg-mesh-hero" />
        <div className="relative max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass text-[12px] font-medium text-gray-600 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            v0.1
          </div>
          <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold tracking-[-0.04em] text-gray-950 leading-[1.05]">
            Know papers<br className="hidden sm:block" /> like never before
          </h1>
          <p className="mt-6 text-[17px] sm:text-lg text-gray-600 max-w-xl mx-auto leading-relaxed">
            Upload any academic paper and let AI transform it into an interactive
            learning experience with summaries, Q&A, derivations, and smart notes.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="/try"
              className="text-[14px] font-medium px-6 py-3 rounded-xl glass glass-hover text-gray-700 transition-all duration-200"
            >
              Try for Free
            </Link>
            <Link
              href="/sign-up"
              className="text-[14px] font-medium px-6 py-3 rounded-xl btn-primary-glass text-white transition-all duration-200"
            >
              Get Started &rarr;
            </Link>
          </div>
          <p className="mt-5 text-[12px] text-gray-400">No credit card required</p>
        </div>
      </section>

      {/* How it works */}
      <section
        ref={howItWorks.ref}
        className="py-28 px-6 border-t border-black/[0.06]"
      >
        <div className="max-w-4xl mx-auto">
          <p className="text-center text-[12px] uppercase tracking-[0.2em] font-semibold text-gray-400 mb-4">
            How it works
          </p>
          <p className="text-center text-[28px] sm:text-3xl font-bold tracking-[-0.03em] text-gray-900 mb-20">
            Three steps to deep understanding
          </p>
          <div className="grid md:grid-cols-3 gap-12 md:gap-8">
            {steps.map((s, i) => (
              <div
                key={s.num}
                className={`relative transition-all duration-700 ${howItWorks.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
                style={{ transitionDelay: `${i * 150}ms` }}
              >
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-b from-gray-800 to-gray-950 text-white flex items-center justify-center text-[14px] font-semibold mb-5 shadow-lg shadow-gray-900/15">
                  {s.num}
                </div>
                <h3 className="text-[16px] font-semibold text-gray-900 mb-2 tracking-[-0.01em]">{s.title}</h3>
                <p className="text-[14px] text-gray-600 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section
        ref={featuresSection.ref}
        className="py-28 px-6 bg-mesh-section border-t border-black/[0.06]"
        id="features"
      >
        <div className="max-w-5xl mx-auto">
          <p className="text-center text-[12px] uppercase tracking-[0.2em] font-semibold text-gray-400 mb-4">
            Features
          </p>
          <p className="text-center text-[28px] sm:text-3xl font-bold tracking-[-0.03em] text-gray-900 mb-20">
            Everything you need to truly understand a paper
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f, i) => (
              <div
                key={f.title}
                className={`group glass glass-hover p-6 rounded-2xl transition-all duration-300 ${featuresSection.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
                style={{ transitionDelay: `${i * 80}ms` }}
              >
                <div className="w-9 h-9 rounded-xl glass-subtle flex items-center justify-center text-gray-400 group-hover:text-gray-600 transition-all duration-300 mb-4">
                  {f.icon}
                </div>
                <h3 className="text-[15px] font-semibold text-gray-900 mb-1.5 tracking-[-0.01em]">{f.title}</h3>
                <p className="text-[13px] text-gray-600 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section
        ref={pricing.ref}
        className="py-28 px-6 border-t border-black/[0.06]"
        id="pricing"
      >
        <div className="max-w-5xl mx-auto">
          <p className="text-center text-[12px] uppercase tracking-[0.2em] font-semibold text-gray-400 mb-4">
            Pricing
          </p>
          <p className="text-center text-[28px] sm:text-3xl font-bold tracking-[-0.03em] text-gray-900 mb-4">
            Simple, transparent pricing
          </p>
          <p className="text-center text-[15px] text-gray-600 mb-16 max-w-md mx-auto">
            Start free, upgrade when you need more. No hidden fees.
          </p>
          <div className="grid md:grid-cols-3 gap-5 items-start">
            {tiers.map((t, i) => (
              <div
                key={t.name}
                className={`relative rounded-2xl p-7 transition-all duration-700 ${
                  t.highlight
                    ? "glass-strong glass-border-glow shadow-[0_8px_40px_rgba(0,0,0,0.06)] scale-[1.02] z-10"
                    : "glass glass-hover"
                } ${pricing.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"}`}
                style={{ transitionDelay: `${i * 120}ms` }}
              >
                {t.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 bg-gradient-to-r from-violet-500 to-purple-600 text-white text-[11px] font-semibold rounded-full tracking-wide shadow-lg shadow-violet-500/25">
                    Most Popular
                  </div>
                )}
                <div className="mb-5">
                  <h3 className="text-[15px] font-semibold text-gray-900">{t.name}</h3>
                  <p className="text-[13px] text-gray-600 mt-0.5">{t.desc}</p>
                </div>
                <div className="flex items-baseline gap-1 mb-7">
                  <span className="text-[36px] font-extrabold tracking-[-0.03em] text-gray-900">{t.price}</span>
                  <span className="text-[14px] text-gray-400 font-medium">{t.period}</span>
                </div>
                <button
                  onClick={() => handleTierClick(t.tier)}
                  disabled={checkoutLoading !== null}
                  className={`block w-full text-center text-[13px] font-semibold py-3 rounded-xl transition-all duration-200 disabled:opacity-50 ${
                    t.highlight
                      ? "btn-primary-glass text-white"
                      : "glass glass-hover text-gray-900"
                  }`}
                >
                  {checkoutLoading === t.tier ? "Redirecting..." : t.cta}
                </button>
                <ul className="mt-7 space-y-3">
                  {t.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-3 text-[13px] text-gray-600" title={FEATURE_TOOLTIPS[feat] || ""}>
                      <svg className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-center text-[12px] text-gray-400 mt-10">
            All payments are final. By subscribing, you agree to our{" "}
            <Link href="/terms" className="underline hover:text-gray-600 transition-colors">
              Terms of Service
            </Link>.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="py-28 px-6 bg-mesh-section border-t border-black/[0.06]">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-[28px] sm:text-3xl font-bold tracking-[-0.03em] text-gray-900 mb-4">
            Ready to know your papers?
          </h2>
          <p className="text-[15px] text-gray-600 mb-10 leading-relaxed">
            Join researchers and students who use Know to deeply understand academic literature.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link
              href="/try"
              className="text-[14px] font-medium px-6 py-3 rounded-xl glass glass-hover text-gray-700 transition-all duration-200"
            >
              Try for Free
            </Link>
            <Link
              href="/sign-up"
              className="text-[14px] font-medium px-6 py-3 rounded-xl btn-primary-glass text-white transition-all duration-200"
            >
              Get Started &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-black/[0.06] py-10 px-6 glass-subtle">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Image src="/logo.png" alt="Know" width={18} height={18} className="rounded-sm" />
            <span className="text-[13px] text-gray-400">&copy; {new Date().getFullYear()} Know</span>
          </div>
          <div className="flex items-center gap-8">
            <a href="#pricing" className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors">
              Pricing
            </a>
            <Link href="/terms" className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors">
              Terms
            </Link>
            <button
              onClick={() => setShowFeedback(true)}
              className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors"
            >
              Feedback
            </button>
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors flex items-center gap-1.5">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
              Discord
            </a>
          </div>
        </div>
      </footer>

      <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} />
    </div>
  );
}
