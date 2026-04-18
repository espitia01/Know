"use client";

import Link from "next/link";
import Image from "next/image";
import { useAuth } from "@clerk/nextjs";

export default function TermsOfServicePage() {
  const { isSignedIn } = useAuth();
  const homeHref = isSignedIn ? "/dashboard" : "/";

  return (
    <div className="min-h-screen bg-white">
      <nav className="sticky top-0 z-50 bg-white/90 backdrop-blur-xl border-b border-gray-100/80">
        <div className="max-w-6xl mx-auto px-6 h-[60px] flex items-center justify-between">
          <Link href={homeHref} className="flex items-center gap-2">
            <Image src="/logo.png" alt="Know" width={24} height={24} className="rounded-md" />
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-gray-900">Know</span>
          </Link>
          <Link
            href={homeHref}
            className="text-[13px] font-medium text-gray-400 hover:text-gray-700 transition-colors"
          >
            &larr; Back
          </Link>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-20">
        <h1 className="text-[32px] font-extrabold tracking-[-0.04em] text-gray-950 mb-2">
          Terms of Service
        </h1>
        <p className="text-[13px] text-gray-400 mb-12">
          Last updated: April 17, 2026
        </p>

        <div className="space-y-10 text-[14px] leading-[1.75] text-gray-600">
          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">1. Acceptance of Terms</h2>
            <p>
              By accessing or using Know (&ldquo;the Service&rdquo;), you agree to be bound by these Terms
              of Service. If you do not agree to these terms, do not use the Service. We reserve
              the right to update these terms at any time; continued use constitutes acceptance of
              any changes.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">2. Description of Service</h2>
            <p>
              Know is an AI-powered platform that transforms academic papers into interactive
              learning experiences. The Service includes features such as paper uploading, AI
              summaries, pre-reading preparation, assumption analysis, interactive Q&A, figure
              analysis, and smart notes, subject to your subscription tier.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">3. Accounts &amp; Authentication</h2>
            <p>
              You must create an account to access paid features. You are responsible for
              maintaining the confidentiality of your account credentials and for all activity
              under your account. You agree to provide accurate information and to notify us
              immediately of any unauthorized use.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">4. Subscriptions &amp; Billing</h2>
            <p>
              Know offers Free, Scholar ($10/month), and Researcher ($20/month) subscription tiers.
              Paid subscriptions are billed monthly through Stripe. By subscribing, you authorize
              us to charge the payment method on file at the start of each billing cycle.
            </p>
            <p className="mt-3">
              You may cancel your subscription at any time from your account settings. When you
              cancel, you retain full access to your current plan until the end of the billing
              period. After that, your account reverts to the Free tier.
            </p>
            <p className="mt-3">
              <strong className="text-gray-800">Upgrades.</strong> You may upgrade your plan at any time (e.g., from Scholar
              to Researcher). When you upgrade mid-cycle, your account is credited for the unused
              portion of your current plan and charged the prorated cost of the new plan for the
              remainder of the billing period. The new plan&apos;s full price applies starting at
              the next billing cycle. All prorated charges are processed automatically by Stripe.
            </p>
          </section>

          <section className="bg-amber-50/60 border border-amber-200/60 rounded-2xl p-6">
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">5. No Refunds Policy</h2>
            <p className="text-gray-700">
              <strong>All payments are final and non-refundable.</strong> This includes monthly
              subscription charges, prorated upgrade charges, and any other fees. When you cancel
              a subscription, you retain full access to your current plan until the end of your
              billing period. We do not provide refunds, partial refunds, or credits for unused
              time on any subscription.
            </p>
            <p className="mt-3 text-gray-700">
              When upgrading mid-cycle, the prorated charge for the new plan is also
              non-refundable. By upgrading, you agree to the immediate charge of the prorated
              difference.
            </p>
            <p className="mt-3 text-gray-700">
              By subscribing to or upgrading a paid plan, you acknowledge and agree that you will
              not be entitled to a refund for any reason, including but not limited to
              dissatisfaction with the Service, failure to use the Service, or accidental purchase.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">6. Acceptable Use</h2>
            <p>
              You agree not to misuse the Service. This includes, but is not limited to:
            </p>
            <ul className="list-disc ml-5 mt-3 space-y-1.5 text-gray-500">
              <li>Attempting to reverse-engineer, decompile, or extract source code from the Service</li>
              <li>Using automated tools to scrape, crawl, or download content from the Service</li>
              <li>Sharing your account credentials with third parties</li>
              <li>Uploading content that infringes on intellectual property rights</li>
              <li>Using the Service for any illegal or unauthorized purpose</li>
              <li>Interfering with or disrupting the Service&apos;s infrastructure</li>
            </ul>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">7. Intellectual Property</h2>
            <p>
              You retain ownership of the papers you upload. Know does not claim any rights to
              your uploaded content. The AI-generated analyses are provided as a service and may
              be used freely by you. The Know platform, its branding, design, and underlying
              technology remain the property of Know.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">8. AI-Generated Content Disclaimer</h2>
            <p>
              The analyses, summaries, and answers generated by Know&apos;s AI features are
              provided for educational purposes only. They may contain inaccuracies or
              misinterpretations. You should not rely solely on AI-generated content for
              academic work, research conclusions, or any consequential decisions. Always
              verify AI output against the original source material.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">9. Privacy &amp; Data</h2>
            <p>
              We collect and process data as necessary to provide the Service. Uploaded papers
              are stored securely and are only accessible to your account. We do not sell your
              data to third parties. We use third-party services (Clerk for authentication,
              Stripe for payments, Supabase for data storage) which have their own privacy
              policies.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">10. Service Availability</h2>
            <p>
              We strive to keep the Service available at all times but make no guarantees of
              uptime. The Service is provided &ldquo;as is&rdquo; without warranties of any kind,
              whether express or implied. We reserve the right to modify, suspend, or discontinue
              the Service at any time without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">11. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, Know and its operators shall not be liable
              for any indirect, incidental, special, consequential, or punitive damages arising
              from your use of the Service, including but not limited to loss of data, loss of
              profits, or academic consequences.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">12. Termination</h2>
            <p>
              We may suspend or terminate your account at our discretion if you violate these
              terms. Upon termination, your right to use the Service ceases immediately. Any
              outstanding payments remain due. Sections regarding intellectual property,
              limitation of liability, and the no-refund policy survive termination.
            </p>
          </section>

          <section>
            <h2 className="text-[15px] font-semibold text-gray-900 mb-2">13. Contact</h2>
            <p>
              For questions about these terms, please use the feedback button in the application
              or reach out through our{" "}
              <a href="https://discord.gg/BgNdPsVfDE" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600 transition-colors">Discord community</a>.
            </p>
          </section>
        </div>

        <div className="mt-20 pt-8 border-t border-gray-100 text-center">
          <Link
            href={homeHref}
            className="text-[13px] font-medium text-gray-400 hover:text-gray-700 transition-colors"
          >
            &larr; Back to Know
          </Link>
        </div>
      </main>
    </div>
  );
}
