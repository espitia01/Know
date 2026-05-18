"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { UserButton, useAuth } from "@clerk/nextjs";
import { ArrowRight, Check } from "lucide-react";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";
import { api } from "@/lib/api";
import { FeedbackModal } from "@/components/FeedbackModal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DISCORD_URL } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Landing page rebuilt around an editorial, calm aesthetic — closer to
 * Inflection / Anthropic / Linear marketing pages than a feature-card
 * dashboard. The previous version layered eight scroll-revealed sections,
 * SVG-icon feature cards, marquee logos, gradient blooms, and per-card
 * staggered animations. That all stacked into a busy first impression.
 *
 * Rules applied:
 *   - One display weight for headlines, no `font-display` everywhere.
 *   - Static surfaces only — no scroll fade-ins, no marquee.
 *   - Lucide icons used sparingly (CTA arrow, pricing checks); feature
 *     blocks lead with typography, not icons.
 *   - Single accent (foreground/background); existing color tokens only.
 *   - Generous vertical rhythm: each section gets enough room to breathe.
 *   - Demo is the visual anchor, not decoration.
 */

const TRUST_LOGOS = [
  { name: "MIT", file: "mit.svg", className: "h-6 w-auto sm:h-7" },
  { name: "Harvard University", file: "harvard.svg", className: "h-6 w-auto sm:h-7" },
  { name: "Princeton University", file: "Princeton-University-Logo-Vector.png", className: "h-6 w-auto sm:h-7" },
  { name: "UC Berkeley", file: "University_of_California,_Berkeley_logo.svg.png", className: "h-7 w-auto sm:h-8" },
  { name: "Caltech", file: "Caltech_Logo.svg.png", className: "h-6 w-auto sm:h-7" },
  { name: "Carnegie Mellon", file: "CMU_Logo_Stack_Red.png", className: "h-9 w-auto sm:h-10" },
  { name: "UT Austin", file: "University_of_Texas_at_Austin_logo.svg.png", className: "h-6 w-auto sm:h-7" },
  { name: "Georgia Tech", file: "Georgia_Tech_Yellow_Jackets_logo.svg", className: "h-7 w-auto sm:h-8" },
  { name: "Duke University", file: "Duke_University_logo.svg.png", className: "h-6 w-auto sm:h-7" },
  { name: "Columbia University", file: "0*3qIWoFnZgVUtsXB-.png", className: "h-9 w-auto sm:h-10" },
  { name: "Indian Institute of Science", file: "IISc_Master_Seal_Black_Transparent.png", className: "h-9 w-auto sm:h-10" },
] as const;

const NARRATIVE_BLOCKS = [
  {
    eyebrow: "Read-along reading",
    title: "Stay with the paper.",
    body:
      "Know holds the original PDF in view while AI annotates beside it. Selections, summaries, and follow-ups all stay anchored to the lines you're reading — so the work compounds instead of evaporating when you close the tab.",
  },
  {
    eyebrow: "Interrogate, don't skim",
    title: "Ask precise questions of the text.",
    body:
      "Highlight any passage and Know explains it, derives it, or surfaces the assumptions it depends on. Answers cite the paper rather than drifting into generic lecture mode. You stay critical; the model stays grounded.",
  },
  {
    eyebrow: "Notes that hold up",
    title: "Capture what clicked, where it clicked.",
    body:
      "Save a derivation, a clarification, or a marginal thought — all tied back to the passage that prompted it. Search later, export later, or just trust that what felt obvious yesterday will be there tomorrow.",
  },
] as const;

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    summary: "Sample the full reader on a few papers — perfect before you commit.",
    cta: "Start free",
    tier: "free",
    highlight: false,
    features: [
      "Up to 3 papers in your library",
      "Structured summaries on every paper",
      "5 grounded Q&A turns per paper",
      "3 selection analyses per paper",
      "Claude Haiku for fast answers",
    ],
  },
  {
    name: "Scholar",
    price: "$10",
    period: "per month",
    summary: "Higher caps, prep tools, exports — the toolkit serious coursework expects.",
    cta: "Subscribe to Scholar",
    tier: "scholar",
    highlight: true,
    features: [
      "Up to 25 papers",
      "Pre-reading prep & concept map",
      "Methodology and assumption lenses",
      "100 Q&A and 100 selections per paper",
      "Figure conversations",
      "Notes anchored to selections",
      "BibTeX and citation export",
      "Haiku and Sonnet models",
    ],
  },
  {
    name: "Researcher",
    price: "$20",
    period: "per month",
    summary: "Uncapped depth, cross-paper reasoning, and the strongest model when stakes are high.",
    cta: "Subscribe to Researcher",
    tier: "researcher",
    highlight: false,
    features: [
      "Unlimited papers and libraries",
      "Everything in Scholar, unlocked",
      "Unlimited Q&A and selections",
      "Cross-paper sessions",
      "Opus when quality matters most",
    ],
  },
] as const;

function trustPublicSrc(filename: string) {
  return `/trust/${encodeURIComponent(filename)}`;
}

function ArcadeEmbed() {
  return (
    <div
      className="w-full overflow-hidden rounded-[var(--radius-xl)] border border-border/55 bg-card/40 shadow-[var(--shadow-md)]"
      style={{ position: "relative", paddingBottom: "calc(55.67% + 41px)", height: 0 }}
    >
      <iframe
        src="https://demo.arcade.software/FdmtEjGlxgDKSz0UfxW6?embed&embed_mobile=tab&embed_desktop=tab&show_copy_link=true"
        title="Know product demo"
        loading="lazy"
        allowFullScreen
        allow="clipboard-write"
        className="absolute left-0 top-0 h-full w-full border-0"
        style={{ colorScheme: "light" }}
      />
    </div>
  );
}

export default function LandingPage() {
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
        `${window.location.origin}/#pricing`,
      );
      if (url) window.location.href = url;
    } catch {
      setCheckoutLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-foreground/12">
      {/* ─── Header ────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            <Image src="/logo.png" alt="" width={22} height={22} className="rounded-[var(--radius-sm)]" />
            <span className="text-[14px] font-semibold tracking-[-0.025em]">Know</span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-6">
            <div className="hidden items-center gap-7 text-[13px] tracking-tight text-muted-foreground sm:flex">
              <a href="#features" className="transition-colors hover:text-foreground">Product</a>
              <a href="#pricing" className="transition-colors hover:text-foreground">Pricing</a>
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">Community</a>
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
                  className="inline-flex items-center gap-1 rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
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

      <main>
        {/* ─── Hero ──────────────────────────────────────────────────── */}
        <section className="border-b border-border/40 px-5 pb-20 pt-20 sm:px-8 sm:pb-28 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <p className="mb-7 text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              A reading companion for technical work
            </p>
            <h1 className="text-balance text-[clamp(2.4rem,5.6vw,4rem)] font-semibold leading-[1.04] tracking-[-0.045em]">
              Stay with the paper until it actually&nbsp;makes&nbsp;sense.
            </h1>
            <p className="mx-auto mt-7 max-w-xl text-pretty text-[16px] leading-[1.65] text-muted-foreground sm:text-[17px]">
              Know keeps summaries, interrogations, and notes tied to the lines you&apos;re reading,
              so your effort compounds — instead of evaporating when you close the tab.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/sign-up"
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-6 py-3 text-[14px] font-medium text-background shadow-sm transition-opacity hover:opacity-90"
              >
                Create an account
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link
                href="/try"
                className="inline-flex items-center rounded-full border border-border bg-background px-6 py-3 text-[14px] font-medium text-foreground shadow-[var(--shadow-xs)] transition-colors hover:bg-muted/50"
              >
                Try the demo
              </Link>
            </div>
            <p className="mt-5 text-[13px] tracking-tight text-muted-foreground/80">No credit card to explore the Free plan.</p>
          </div>
        </section>

        {/* ─── Demo ──────────────────────────────────────────────────── */}
        <section className="px-5 py-20 sm:px-8 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <ArcadeEmbed />
          </div>
        </section>

        {/* ─── Trust ─────────────────────────────────────────────────── */}
        <section className="border-y border-border/40 bg-muted/30 px-5 py-14 sm:px-8 dark:bg-muted/[0.04]">
          <div className="mx-auto max-w-5xl">
            <p className="text-center text-[12px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Used by readers at
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-9 gap-y-6 sm:gap-x-12">
              {TRUST_LOGOS.map(({ name, file, className }) => (
                <Image
                  key={file}
                  src={trustPublicSrc(file)}
                  alt={name}
                  width={240}
                  height={60}
                  unoptimized
                  className={cn(
                    className,
                    "max-w-[160px] object-contain opacity-60 grayscale transition-opacity hover:opacity-90",
                    "dark:opacity-70 dark:brightness-110",
                  )}
                  loading="lazy"
                />
              ))}
            </div>
          </div>
        </section>

        {/* ─── Narrative blocks ──────────────────────────────────────── */}
        <section id="features" className="px-5 py-24 sm:px-8 sm:py-32">
          <div className="mx-auto max-w-3xl">
            <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Product</p>
            <h2 className="mt-3 text-balance text-[clamp(1.85rem,3.6vw,2.5rem)] font-semibold leading-[1.15] tracking-[-0.035em]">
              Built for technical papers — not pasted chat on an upload box.
            </h2>
          </div>
          <div className="mx-auto mt-20 grid max-w-5xl gap-20 sm:gap-24">
            {NARRATIVE_BLOCKS.map((block, i) => (
              <article
                key={block.title}
                className={cn(
                  "grid gap-8 sm:gap-12",
                  "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start",
                )}
              >
                <div className="lg:max-w-[18rem]">
                  <p className="text-[12px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                    {block.eyebrow}
                  </p>
                  <p className="mt-4 font-mono text-[12px] tabular-nums text-muted-foreground/70">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                </div>
                <div>
                  <h3 className="text-balance text-[clamp(1.4rem,2.4vw,1.7rem)] font-semibold leading-[1.2] tracking-[-0.03em]">
                    {block.title}
                  </h3>
                  <p className="mt-4 max-w-prose text-pretty text-[15.5px] leading-[1.7] text-muted-foreground">
                    {block.body}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ─── Pricing ───────────────────────────────────────────────── */}
        <section
          id="pricing"
          className="scroll-mt-20 border-t border-border/40 bg-muted/[0.18] px-5 py-24 dark:bg-muted/[0.04] sm:px-8 sm:py-32"
        >
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-[12px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Pricing</p>
            <h2 className="mt-3 text-balance text-[clamp(1.85rem,3.6vw,2.5rem)] font-semibold leading-[1.15] tracking-[-0.035em]">
              Simple tiers. No surprise limits on the core reader.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-pretty text-[15.5px] leading-[1.7] text-muted-foreground">
              Start free. Subscribe when you need higher caps or cross-paper workflows.
            </p>
          </div>
          <div className="mx-auto mt-16 grid max-w-6xl gap-5 md:grid-cols-3">
            {TIERS.map((t) => (
              <div
                key={t.name}
                className={cn(
                  "relative flex flex-col rounded-[var(--radius-xl)] border bg-background px-7 pb-9 pt-9",
                  t.highlight
                    ? "border-foreground/20 shadow-[var(--shadow-md)] ring-1 ring-foreground/[0.04] dark:border-foreground/30"
                    : "border-border/55 dark:bg-card/40",
                )}
              >
                {t.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-border/55 bg-background px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground/80 shadow-[var(--shadow-xs)]">
                    Recommended
                  </div>
                )}
                <h3 className="text-[18px] font-semibold tracking-[-0.025em]">{t.name}</h3>
                <p className="mt-2.5 text-[14px] leading-[1.6] text-muted-foreground">{t.summary}</p>
                <div className="mt-7 flex items-baseline gap-1.5">
                  <span className="text-[40px] font-semibold tracking-[-0.04em]">{t.price}</span>
                  <span className="text-[13px] text-muted-foreground">{t.period}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleTierClick(t.tier)}
                  disabled={checkoutLoading !== null}
                  className={cn(
                    "mt-7 inline-flex h-10 items-center justify-center rounded-full px-5 text-[14px] font-medium transition-opacity disabled:opacity-50",
                    t.highlight
                      ? "bg-foreground text-background hover:opacity-90"
                      : "border border-border bg-background text-foreground hover:bg-muted/50",
                  )}
                >
                  {checkoutLoading === t.tier ? "Redirecting…" : t.cta}
                </button>
                <ul className="mt-9 space-y-3.5">
                  {t.features.map((feat) => (
                    <li
                      key={feat}
                      className="flex items-start gap-2.5 text-[13.5px] leading-[1.55] text-muted-foreground"
                      title={FEATURE_TOOLTIPS[feat] || ""}
                    >
                      <Check className="mt-[3px] h-3.5 w-3.5 shrink-0 text-foreground/65" aria-hidden />
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mx-auto mt-12 max-w-xl text-center text-[12px] leading-[1.7] text-muted-foreground/80">
            Paid plans renew monthly until cancelled. By subscribing you accept our{" "}
            <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
              Terms of Service
            </Link>
            .
          </p>
        </section>

        {/* ─── Closing ───────────────────────────────────────────────── */}
        <section className="border-t border-border/40 px-5 py-24 sm:px-8 sm:py-32">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-balance text-[clamp(1.65rem,3.2vw,2.1rem)] font-semibold leading-[1.18] tracking-[-0.035em]">
              Make the next paper the one you finish with clarity.
            </h2>
            <p className="mx-auto mt-5 max-w-md text-pretty text-[15.5px] leading-[1.7] text-muted-foreground">
              Upload something intimidating. Know helps you interrogate it, on your terms, line by line.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Link
                href="/sign-up"
                className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-6 py-3 text-[14px] font-medium text-background shadow-sm transition-opacity hover:opacity-90"
              >
                Create an account
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link
                href="/try"
                className="inline-flex items-center rounded-full border border-border bg-background px-6 py-3 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/50"
              >
                Try the demo
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/40 px-5 py-12 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 sm:flex-row">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Image src="/logo.png" alt="" width={16} height={16} className="rounded-[var(--radius-sm)]" />
            <span>&copy; {new Date().getFullYear()} Know</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2 text-[12.5px] text-muted-foreground">
            <a href="#pricing" className="transition-colors hover:text-foreground">Pricing</a>
            <Link href="/terms" className="transition-colors hover:text-foreground">Terms</Link>
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
