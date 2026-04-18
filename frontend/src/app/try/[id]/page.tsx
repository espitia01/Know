"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PaperSummary } from "@/lib/api";
import { FEATURE_TOOLTIPS } from "@/lib/tooltips";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const PdfViewer = dynamic(
  () => import("@/components/pdf/PdfViewer").then((m) => m.PdfViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full">
        <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-900 rounded-full animate-spin" />
      </div>
    ),
  }
);

function Md({ children }: { children: string }) {
  return (
    <div className="analysis-content">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

function TrialSummary({ paperId }: { paperId: string }) {
  const [summary, setSummary] = useState<PaperSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${API_BASE}/api/trial/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_id: paperId }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setSummary(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [paperId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="w-full max-w-xs h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-gray-400 rounded-full animate-pulse" style={{ width: "60%" }} />
        </div>
        <p className="text-[13px] text-gray-500">Generating detailed summary...</p>
        <p className="text-[11px] text-gray-400">This may take 30-60 seconds</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="text-center py-8">
        <p className="text-[13px] text-gray-500">Summary not available.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {summary.overview && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Overview</h3>
          <Md>{summary.overview}</Md>
        </section>
      )}
      {summary.motivation && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Motivation</h3>
          <Md>{summary.motivation}</Md>
        </section>
      )}
      {summary.key_contributions?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Key Contributions</h3>
          <ul className="space-y-1.5">
            {summary.key_contributions.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[12px] text-gray-300 shrink-0 mt-0.5">{i + 1}.</span>
                <Md>{c}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.methodology && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Methodology</h3>
          <Md>{summary.methodology}</Md>
        </section>
      )}
      {summary.main_results && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Main Results</h3>
          <Md>{summary.main_results}</Md>
        </section>
      )}
      {summary.limitations?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Limitations</h3>
          <ul className="space-y-1">
            {summary.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[12px] text-gray-300 shrink-0">•</span>
                <Md>{l}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const LOCKED_TABS = ["Prepare", "Assumptions", "Q&A", "Notes", "Figures"];

export default function TrialPaperView() {
  const { id } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState("Summary");
  const [title, setTitle] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/api/trial/paper/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.title) setTitle(data.title); })
      .catch(() => {});
  }, [id]);

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Trial banner */}
      <div className="bg-gray-900 text-center py-2.5 px-4 shrink-0">
        <p className="text-[13px] text-gray-300">
          Trial mode — only the summary is available.{" "}
          <Link href="/sign-up" className="text-white font-medium hover:underline">
            Sign up free
          </Link>{" "}
          to unlock all features.
        </p>
      </div>

      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-4 h-[48px] border-b border-gray-100 bg-white">
        <Link href="/try" className="text-gray-400 hover:text-gray-700 transition-colors text-[13px] font-medium">
          &larr;
        </Link>
        <div className="h-4 w-px bg-gray-200" />
        <Image src="/logo.png" alt="Know" width={20} height={20} className="shrink-0 rounded-md" />
        <p className="text-[13px] font-medium text-gray-900 truncate flex-1">
          {title || "Paper"}
        </p>
        <Link
          href="/sign-up"
          className="text-[12px] font-medium bg-gray-900 text-white px-3 py-1 rounded-lg hover:bg-gray-800 transition-colors shrink-0"
        >
          Sign Up
        </Link>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* PDF viewer */}
        <div className="flex-1 overflow-auto bg-gray-50">
          <PdfViewer url={`${API_BASE}/api/trial/paper/${id}/pdf`} />
        </div>

        {/* Side panel */}
        <div className="w-[400px] border-l border-gray-100 flex flex-col bg-white shrink-0">
          {/* Tabs */}
          <div className="shrink-0 border-b border-gray-100 overflow-x-auto">
            <div className="flex gap-0 px-2 pt-1.5">
              <button
                onClick={() => setActiveTab("Summary")}
                title={FEATURE_TOOLTIPS["Summary"]}
                className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === "Summary"
                    ? "border-gray-900 text-gray-900"
                    : "border-transparent text-gray-400 hover:text-gray-600"
                }`}
              >
                Summary
              </button>
              {LOCKED_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  title={FEATURE_TOOLTIPS[tab] || ""}
                  className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-1 ${
                    activeTab === tab
                      ? "border-gray-900 text-gray-900"
                      : "border-transparent text-gray-400 hover:text-gray-600"
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4">
            {activeTab === "Summary" ? (
              <TrialSummary paperId={id} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mb-4">
                  <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                </div>
                <h3 className="text-[15px] font-semibold text-gray-900 mb-1.5">
                  {activeTab} is a paid feature
                </h3>
                <p className="text-[13px] text-gray-500 mb-5 max-w-xs">
                  Sign up for free to access {activeTab}, Q&A, figure analysis, notes, and more.
                </p>
                <Link
                  href="/sign-up"
                  className="text-[13px] font-medium bg-gray-900 text-white px-5 py-2 rounded-xl hover:bg-gray-800 transition-colors"
                >
                  Sign Up Free &rarr;
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
