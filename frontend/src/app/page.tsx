"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { UserButton, useAuth } from "@clerk/nextjs";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import { api } from "@/lib/api";
import { FeedbackModal } from "@/components/FeedbackModal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DISCORD_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

function trustPublicSrc(filename: string) {
  return `/trust/${encodeURIComponent(filename)}`;
}

function ArcadeEmbed() {
  return (
    <div
      className="w-full overflow-hidden rounded-[var(--radius-lg)] border border-border/55 bg-muted/[0.08] shadow-[var(--shadow-xs)]"
      style={{ position: "relative", paddingBottom: "calc(55.67129629629629% + 41px)", height: 0, width: "100%" }}
    >
      <iframe
        src="https://demo.arcade.software/FdmtEjGlxgDKSz0UfxW6?embed&embed_mobile=tab&embed_desktop=tab&show_copy_link=true"
        title="Know product demo (Arcade)"
        loading="lazy"
        allowFullScreen
        allow="clipboard-write"
        className="absolute left-0 top-0 h-full w-full border-0 rounded-[calc(var(--radius-lg)-1px)]"
        style={{ colorScheme: "light" }}
      />
    </div>
  );
}

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

/** One entry per file in `frontend/public/trust` (11 assets — keep in sync). */
const TRUST_LOGOS = [
  {
    name: "University of California, Berkeley",
    file: "University_of_California,_Berkeley_logo.svg.png",
    className: "h-7 w-auto sm:h-8 max-w-[180px] object-contain object-left",
  },
  {
    name: "California Institute of Technology",
    file: "Caltech_Logo.svg.png",
    className: "h-6 w-auto sm:h-7 max-w-[120px] object-contain object-left",
  },
  {
    name: "Carnegie Mellon University",
    file: "CMU_Logo_Stack_Red.png",
    className: "h-12 w-auto sm:h-14 max-w-[76px] object-contain object-left",
  },
  {
    name: "Columbia University",
    file: "0*3qIWoFnZgVUtsXB-.png",
    className: "h-10 w-auto sm:h-11 max-w-[64px] object-contain object-left",
  },
  {
    name: "Duke University",
    file: "Duke_University_logo.svg.png",
    className: "h-6 w-auto sm:h-7 max-w-[140px] object-contain object-left",
  },
  {
    name: "Georgia Institute of Technology",
    file: "Georgia_Tech_Yellow_Jackets_logo.svg",
    className: "h-8 w-auto sm:h-9 max-w-[56px] object-contain object-left",
  },
  {
    name: "Harvard University",
    file: "harvard.svg",
    className: "h-7 w-auto sm:h-8 max-w-[140px] object-contain object-left",
  },
  {
    name: "Indian Institute of Science",
    file: "IISc_Master_Seal_Black_Transparent.png",
    className: "h-10 w-auto sm:h-11 max-w-[88px] object-contain object-left",
  },
  {
    name: "MIT",
    file: "mit.svg",
    className: "h-6 w-auto sm:h-7 max-w-[108px] object-contain object-left",
  },
  {
    name: "Princeton University",
    file: "Princeton-University-Logo-Vector.png",
    className: "h-6 w-auto sm:h-7 max-w-[200px] object-contain object-left",
  },
  {
    name: "The University of Texas at Austin",
    file: "University_of_Texas_at_Austin_logo.svg.png",
    className: "h-7 w-auto sm:h-8 max-w-[220px] object-contain object-left",
  },
] as const;

const features = [
  {
    title: "Structured summaries",
    desc: "Motivation, methodology, results, and equations distilled into a single pass you can skim or drill into.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
  {
    title: "Pre-reading orientation",
    desc: "Definitions, core concepts, and the questions the paper is really trying to answer—before you hit page one.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
      </svg>
    ),
  },
  {
    title: "Assumption lens",
    desc: "Surfaces what the argument takes for granted—so you can judge whether the evidence actually carries the claim.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
      </svg>
    ),
  },
  {
    title: "Grounded Q&A",
    desc: "Ask precise questions; answers trace back to the PDF instead of drifting into generic lecture mode.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
    ),
  },
  {
    title: "Figure conversations",
    desc: "Click a plot or diagram and walk through it with the model—axis choices, trends, and caveats included.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75A2.25 2.25 0 001.5 6.75v12a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    title: "Notes anchored in text",
    desc: "Capture what clicked while the selection is still on screen—explanations, derivations, and marginalia in one flow.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.25}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
      </svg>
    ),
  },
];

const steps = [
  {
    num: "01",
    title: "Bring the PDF",
    desc: "Drop arXiv preprints, journal PDFs, or lecture notes—Know keeps the layout faithful while models read with you.",
  },
  {
    num: "02",
    title: "Orient, then read",
    desc: "Skim the briefing layer—summary, prep, figures—then move line by line with questions or derivations on demand.",
  },
  {
    num: "03",
    title: "Finish with understanding",
    desc: "Leave with annotated selections, notes, and exports that match how you actually study—not a wall of highlights.",
  },
];

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    summary: "Sample the full reader on a few papers each month—perfect before you commit.",
    idealFor: "Exploring the workflow",
    cta: "Start free",
    tier: "free",
    highlight: false,
    features: [
      "Up to 3 papers in your library",
      "Structured AI summary for each paper",
      "5 Q&A turns per paper, grounded in the text",
      "3 selection analyses per paper (explain incl. passage assumptions, derive)",
      "Claude Haiku for fast answers",
    ],
  },
  {
    name: "Scholar",
    price: "$10",
    period: "/month",
    summary: "The toolkit serious coursework and literature reviews expect—higher caps, richer prep, and exports.",
    idealFor: "Undergrads & dedicated readers",
    cta: "Subscribe to Scholar",
    tier: "scholar",
    highlight: true,
    features: [
      "Up to 25 papers",
      "Everything in Free, plus pre-reading prep & concept map",
      "Full assumption and methodology lens",
      "100 Q&A and 100 selections per paper",
      "Figures you can interrogate",
      "Notes tied to selections",
      "BibTeX and citation export",
      "Haiku or Sonnet models",
    ],
  },
  {
    name: "Researcher",
    price: "$20",
    period: "/month",
    summary: "For people living inside PDFs—uncapped depth, cross-paper reasoning, and the strongest model when stakes are high.",
    idealFor: "Grad students, PIs, reviewers, thinkers",
    cta: "Subscribe to Researcher",
    tier: "researcher",
    highlight: false,
    features: [
      "Unlimited papers & libraries",
      "Everything in Scholar, unlocked",
      "Unlimited Q&A & selections",
      "Cross-paper sessions",
      "Opus when quality matters most",
    ],
  },
];

export default function LandingPage() {
  const hero = useInView(0.12);
  const trust = useInView(0.15);
  const howItWorks = useInView(0.12);
  const featuresSection = useInView(0.1);
  const pricing = useInView(0.1);
  const { isSignedIn, isLoaded } = useAuth();
  const [showFeedback, setShowFeedback] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const handleTierClick = async (tierKey: string) => {
    if (tierKey === "free") {
      window.location.href = "/sign-up";
      return;
    }
    if (!isLoaded) return;
    if (!isSignedIn) {
      window.location.href = "/sign-up";
      return;
    }
    setCheckoutLoading(tierKey);
    try {
      const { url } = await api.createCheckoutSession(
        tierKey,
        `${window.location.origin}/dashboard?upgraded=1`,
        `${window.location.origin}/#pricing`
      );
      if (url) window.location.href = url;
    } catch {
      setCheckoutLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-ring/20">
      {/* Nav + hero share one surface */}
      <div className="relative overflow-hidden border-b border-border/40">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_72%_52%_at_50%_-12%,color-mix(in_oklch,var(--foreground),transparent_96%),transparent)] opacity-90" />
        <header className="relative z-50 sticky top-0 border-b border-border/35 bg-background/80 shadow-[var(--shadow-xs)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/58">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
            <Link href="/" className="flex items-center gap-2.5 rounded-md ring-focus">
              <Image src="/logo.png" alt="Know" width={24} height={24} className="rounded-md opacity-[0.97]" />
              <span className="text-[14px] font-semibold tracking-[-0.03em] text-foreground">Know</span>
            </Link>
            <nav className="flex items-center gap-1 sm:gap-5">
              <div className="hidden items-center gap-7 text-[13px] tracking-[-0.01em] text-muted-foreground sm:flex">
                <a href="#features" className="transition-colors hover:text-foreground">
                  Product
                </a>
                <a href="#pricing" className="transition-colors hover:text-foreground">
                  Pricing
                </a>
                <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">
                  Community
                </a>
              </div>
              <ThemeToggle />
              {isLoaded && !isSignedIn && (
                <>
                  <Link
                    href="/sign-in"
                    className="hidden text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline"
                  >
                    Sign in
                  </Link>
                  <Link
                    href="/sign-up"
                    className="rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background shadow-sm transition-opacity hover:opacity-[0.92] active:opacity-100"
                  >
                    Get started
                  </Link>
                </>
              )}
              {isLoaded && isSignedIn && (
                <>
                  <Link
                    href="/dashboard"
                    className="text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Dashboard
                  </Link>
                  <UserButton appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }} />
                </>
              )}
            </nav>
          </div>
        </header>

        {/* Hero */}
        <section
          ref={hero.ref}
          className={cn(
            "relative z-10 px-5 pb-[5.5rem] pt-14 sm:px-8 sm:pb-24 sm:pt-[4.25rem]",
            "transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
            hero.visible ? "opacity-100" : "opacity-0 translate-y-3",
          )}
        >
          <div className="relative mx-auto max-w-3xl text-center">
            <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground sm:text-[12px]">
              Reading companion for technical work
            </p>
            <h1 className="font-display text-[clamp(2.2rem,5.2vw,3.65rem)] font-semibold leading-[1.07] tracking-[-0.045em] text-foreground text-balance">
              Stay with the paper until it actually makes sense.
            </h1>
            <p className="mx-auto mt-8 max-w-xl text-pretty text-[16px] leading-[1.62] text-muted-foreground sm:text-[17px]">
              Know keeps summaries, interrogations, and notes tied to the lines you&apos;re reading—so your effort compounds
              instead of evaporating when you close the tab.
            </p>
            <div className="mt-11 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/try"
                className="rounded-full border border-border/80 bg-background px-6 py-[0.72rem] text-[14px] font-medium text-foreground shadow-[var(--shadow-xs)] transition-[background-color,border-color,box-shadow] duration-150 hover:border-border hover:bg-muted/40"
              >
                Try the demo
              </Link>
              <Link
                href="/sign-up"
                className="rounded-full bg-foreground px-6 py-[0.72rem] text-[14px] font-medium text-background shadow-sm transition-opacity hover:opacity-[0.92]"
              >
                Create an account
              </Link>
            </div>
            <p className="mt-6 text-[13px] tracking-[-0.01em] text-muted-foreground/80">No credit card to explore the Free plan.</p>
          </div>
        </section>
      </div>

      <main>
        {/* Social proof */}
        <section
          ref={trust.ref}
          className={cn(
            "border-b border-border/50 bg-muted/[0.04] px-5 py-[3.25rem] sm:px-8 dark:bg-muted/[0.035]",
            "transition-[opacity,transform] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
            trust.visible ? "opacity-100" : "opacity-0 translate-y-3",
          )}
        >
          <div className="mx-auto max-w-5xl">
            <p className="text-center text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Trusted by readers at leading institutions
            </p>
            <div
              className="mt-10 -mx-5 overflow-hidden sm:-mx-8"
              style={{
                maskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
                WebkitMaskImage: "linear-gradient(to right, transparent, black 10%, black 90%, transparent)",
              }}
            >
              <div
                className={cn(
                  "landing-trust-marquee-track flex w-max items-center gap-12 py-2 sm:gap-14",
                  trust.visible && "landing-trust-marquee-track--running",
                )}
              >
                {[...TRUST_LOGOS, ...TRUST_LOGOS].map(({ name, file, className }, i) => (
                  <Image
                    key={`${file}-${i}`}
                    src={trustPublicSrc(file)}
                    alt={name}
                    width={280}
                    height={80}
                    unoptimized
                    className={cn(
                      className,
                      "shrink-0 opacity-[0.52] grayscale contrast-[0.92]",
                      "dark:opacity-[0.72] dark:brightness-105 dark:contrast-95",
                      "transition-[opacity,filter] duration-300 hover:opacity-[0.72] hover:grayscale-[0.35] dark:hover:opacity-[0.88]",
                    )}
                    loading="lazy"
                    decoding="async"
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Workflow + interactive demo */}
        <section ref={howItWorks.ref} className="px-5 py-[5.25rem] sm:px-8 sm:py-28">
          <div className="mx-auto max-w-6xl">
            <p className="text-center font-display text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Workflow
            </p>
            <h2 className="mx-auto mt-4 max-w-2xl text-center font-display text-[clamp(1.6rem,3.35vw,2.15rem)] font-semibold leading-[1.2] tracking-[-0.035em] text-foreground text-balance">
              Orient deeply, retain what mattered.
            </h2>
            <div
              className={cn(
                "relative mt-12 overflow-hidden rounded-[var(--radius-xl)] border border-border/55 bg-background/80 p-5 shadow-[var(--shadow-sm)] sm:p-7 lg:p-8",
                "dark:bg-background/[0.35]",
                "transition-[opacity,transform,border-color] duration-500 ease-out",
                howItWorks.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
              )}
            >
              <div className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.82fr)] lg:items-start lg:gap-12">
                <div className="min-w-0">
                  <ArcadeEmbed />
                </div>
                <div className="flex min-w-0 flex-col gap-9 lg:justify-center lg:pt-1">
                  {steps.map((s, i) => (
                    <div
                      key={s.num}
                      className={cn(
                        "relative transition-[opacity,transform] duration-500 ease-out",
                        howItWorks.visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
                      )}
                      style={{ transitionDelay: `${120 + i * 55}ms` }}
                    >
                      <div className="mb-3 inline-flex h-8 min-w-[2.5rem] items-center justify-center rounded-md border border-border/70 bg-muted/35 px-2 font-mono text-[11px] font-semibold tabular-nums tracking-tight text-muted-foreground sm:h-9 sm:min-w-[2.75rem] sm:px-2.5 sm:text-[12px]">
                        {s.num}
                      </div>
                      <h3 className="font-display text-[17px] font-semibold tracking-[-0.02em] text-foreground">{s.title}</h3>
                      <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground text-pretty">{s.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section
          ref={featuresSection.ref}
          id="features"
          className="border-t border-border/50 bg-muted/[0.12] px-5 py-[5.25rem] dark:bg-muted/[0.045] sm:px-8 sm:py-28"
        >
          <div className="mx-auto max-w-5xl">
            <p className="text-center font-display text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Product
            </p>
            <h2 className="mx-auto mt-4 max-w-2xl text-center font-display text-[clamp(1.6rem,3.35vw,2.12rem)] font-semibold leading-[1.2] tracking-[-0.035em] text-foreground text-balance">
              Built for technical papers—not pasted chat on an upload box.
            </h2>
            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-x-8 lg:gap-y-10">
              {features.map((f, i) => (
                <div
                  key={f.title}
                  className={cn(
                    "rounded-xl border border-border/50 bg-background/70 p-[1.35rem] shadow-[var(--shadow-xs)] transition-[transform,opacity,border-color] duration-[480ms] ease-out hover:border-border dark:bg-background/[0.2]",
                    featuresSection.visible
                      ? "translate-y-0 opacity-100"
                      : "translate-y-4 opacity-0",
                  )}
                  style={{ transitionDelay: `${i * 45}ms` }}
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/55 bg-muted/35 text-muted-foreground">
                    {f.icon}
                  </div>
                  <h3 className="mt-5 font-display text-[16px] font-semibold tracking-[-0.02em] text-foreground">{f.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground text-pretty">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Plans */}
        <section ref={pricing.ref} id="pricing" className="scroll-mt-20 border-t border-border/50 px-5 py-[5.25rem] sm:px-8 sm:py-28">
          <div className="mx-auto max-w-6xl">
            <p className="text-center font-display text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              Pricing
            </p>
            <h2 className="mx-auto mt-4 max-w-2xl text-center font-display text-[clamp(1.6rem,3.35vw,2.2rem)] font-semibold leading-[1.2] tracking-[-0.035em] text-foreground text-balance">
              Simple tiers
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-center text-[15px] leading-relaxed text-muted-foreground text-pretty">
              Start free. Subscribe when you need higher caps or cross-paper workflows—core reading is never hidden behind surprise limits.
            </p>
            <div className="mx-auto mt-14 grid max-w-xl gap-6 sm:max-w-2xl md:max-w-none md:grid-cols-3 md:gap-6">
              {tiers.map((t, i) => (
                <div
                  key={t.name}
                  className={cn(
                    "flex flex-col rounded-xl border px-7 pb-8 pt-8 transition-[transform,opacity] duration-[520ms] ease-out",
                    t.highlight
                      ? "border-foreground/[0.22] bg-background shadow-[var(--shadow-sm)] ring-1 ring-foreground/[0.06] dark:border-foreground/25"
                      : "border-border/55 bg-background/70 dark:bg-background/35",
                    pricing.visible ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0",
                  )}
                  style={{ transitionDelay: `${i * 72}ms` }}
                >
                  {t.highlight ? (
                    <p className="mb-5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Recommended
                    </p>
                  ) : (
                    <div className="mb-5 h-[18px]" aria-hidden />
                  )}
                  <h3 className="font-display text-[19px] font-semibold tracking-[-0.03em] text-foreground">{t.name}</h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground text-pretty">{t.summary}</p>
                  <p className="mt-4 text-[12px] font-medium text-muted-foreground/90">
                    <span className="text-foreground/75">Ideal for · </span>
                    {t.idealFor}
                  </p>
                  <div className="mt-8 flex items-baseline gap-1 border-t border-border/45 pt-8">
                    <span className="font-display text-[38px] font-semibold tracking-[-0.04em] text-foreground">{t.price}</span>
                    <span className="text-[13px] text-muted-foreground">{t.period}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleTierClick(t.tier)}
                    disabled={checkoutLoading !== null}
                    className={cn(
                      "mt-8 w-full rounded-full py-[0.7rem] text-[14px] font-medium transition-[opacity,background-color,color] disabled:opacity-[0.42]",
                      t.highlight
                        ? "bg-foreground text-background shadow-sm hover:opacity-[0.95]"
                        : "border border-border/75 bg-transparent text-foreground hover:bg-muted/35",
                      "ring-focus",
                    )}
                  >
                    {checkoutLoading === t.tier ? "Redirecting…" : t.cta}
                  </button>
                  <ul className="mt-9 space-y-3">
                    {t.features.map((feat) => (
                      <li
                        key={feat}
                        className="flex gap-3 text-[13px] leading-snug text-muted-foreground"
                        title={FEATURE_TOOLTIPS[feat] || ""}
                      >
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground/30" aria-hidden />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mx-auto mt-12 max-w-xl text-center text-[12px] leading-relaxed text-muted-foreground/80">
              Paid plans renew monthly until cancelled. By subscribing you accept our{" "}
              <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
                Terms of Service
              </Link>
              .
            </p>
          </div>
        </section>

        {/* Closing */}
        <section className="border-t border-border/50 bg-muted/[0.1] px-5 py-[5rem] dark:bg-muted/[0.048] sm:px-8 sm:py-[5.75rem]">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-[clamp(1.45rem,3.05vw,1.92rem)] font-semibold leading-[1.18] tracking-[-0.034em] text-foreground text-balance">
              Make the next paper the one you finish with clarity.
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground text-pretty">
              Upload something intimidating. Know helps you interrogate it—on your terms, line by line.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Link
                href="/try"
                className="rounded-full border border-border/80 px-6 py-[0.72rem] text-[14px] font-medium text-foreground shadow-[var(--shadow-xs)] transition-colors hover:bg-muted/38"
              >
                Try the demo
              </Link>
              <Link
                href="/sign-up"
                className="rounded-full bg-foreground px-6 py-[0.72rem] text-[14px] font-medium text-background shadow-sm transition-opacity hover:opacity-[0.92]"
              >
                Create an account
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/50 px-5 py-12 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Image src="/logo.png" alt="Know" width={18} height={18} className="rounded-sm opacity-90" />
            <span>&copy; {new Date().getFullYear()} Know</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-[12px] text-muted-foreground">
            <a href="#pricing" className="transition-colors hover:text-foreground">
              Pricing
            </a>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <button type="button" onClick={() => setShowFeedback(true)} className="transition-colors hover:text-foreground">
              Feedback
            </button>
            <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">
              Discord
            </a>
          </div>
        </div>
      </footer>

      <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} />
    </div>
  );
}
