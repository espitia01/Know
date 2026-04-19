"use client";

import { Suspense, useCallback, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { UserButton, useUser } from "@clerk/nextjs";
import { api, PaperListEntry } from "@/lib/api";
import { useStore } from "@/lib/store";
import { useUserTier } from "@/lib/UserTierContext";
import { UpgradeModal } from "@/components/UpgradeModal";
import { FeedbackModal } from "@/components/FeedbackModal";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => {
      const ua = navigator.userAgent;
      setIsMobile(/iPhone|iPod|Android/i.test(ua) && window.innerWidth < 768);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

export default function DashboardPage() {
  return (
    <Suspense>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setPaper, loading, setLoading } = useStore();
  const { user: tierUser, refresh: refreshTier } = useUserTier();
  const { user: clerkUser } = useUser();
  const [papers, setPapers] = useState<PaperListEntry[]>([]);
  const [error, setError] = useState("");
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const isMobile = useIsMobile();

  const greeting = (() => {
    const hour = new Date().getHours();
    const name = clerkUser?.firstName || "";
    const nameStr = name ? `, ${name}` : "";
    if (hour < 12) return `Good morning${nameStr}`;
    if (hour < 17) return `Good afternoon${nameStr}`;
    return `Good evening${nameStr}`;
  })();

  useEffect(() => {
    api.listPapers()
      .then(setPapers)
      .catch(() => setError("Failed to load papers. Please refresh."));
  }, []);

  useEffect(() => {
    if (searchParams.get("upgraded") === "1") {
      refreshTier().then(() => setShowUpgradeModal(true));
      window.history.replaceState({}, "", "/dashboard");
    }
  }, [searchParams, refreshTier]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      setError("");
      setLoading(true);
      try {
        const paper = await api.uploadPaper(file);
        setPaper(paper);
        router.push(`/paper/${paper.id}`);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setLoading(false);
      }
    },
    [setPaper, setLoading, router]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
  });

  if (isMobile) {
    return (
      <main className="flex-1 flex flex-col items-center px-6 pt-[15vh] pb-12 bg-mesh min-h-screen">
        <div className="absolute top-5 right-5 flex items-center gap-3">
          {tierUser?.tier === "free" && (
            <a
              href="/#pricing"
              className="text-[12px] font-medium bg-gradient-to-r from-violet-500 to-purple-600 text-white px-3.5 py-1.5 rounded-xl shadow-lg shadow-violet-500/20"
            >
              Upgrade
            </a>
          )}
          <UserButton
            appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }}
          >
            <UserButton.MenuItems>
              <UserButton.Link label="Settings" labelIcon={<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>} href="/settings" />
            </UserButton.MenuItems>
          </UserButton>
        </div>

        <div className="max-w-[400px] w-full space-y-10 text-center">
          <div className="space-y-4">
            <div className="flex justify-center">
              <Image src="/logo.png" alt="Know" width={56} height={56} priority className="rounded-xl" />
            </div>
            <div className="space-y-2">
              <h1 className="text-[24px] font-bold tracking-[-0.04em] text-gray-900">{greeting}</h1>
              <p className="text-gray-600 text-[15px] leading-relaxed">
                Know is optimized for desktop. The full paper analysis experience requires a larger screen.
              </p>
            </div>
          </div>

          <div className="glass rounded-2xl py-12 px-6 space-y-4">
            <div className="w-12 h-12 rounded-xl glass-subtle flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
              </svg>
            </div>
            <p className="text-[16px] font-semibold text-gray-800">Coming soon to mobile</p>
            <p className="text-[13px] text-gray-500 leading-relaxed">
              Please use your computer to upload papers, read with the PDF viewer, and interact with the AI analysis tools.
            </p>
          </div>

          <div className="flex items-center justify-center gap-8 pt-2">
            <button
              onClick={() => router.push("/settings")}
              className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium"
            >
              Settings
            </button>
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
          </div>
        </div>

        <UpgradeModal
          tier={tierUser?.tier || "scholar"}
          open={showUpgradeModal}
          onClose={() => setShowUpgradeModal(false)}
        />
        <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} />
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col items-center px-6 pt-[10vh] pb-12 bg-mesh min-h-screen">
      <div className="absolute top-5 right-5 flex items-center gap-3">
        {tierUser?.tier === "free" && (
          <Link
            href="/#pricing"
            className="text-[12px] font-medium bg-gradient-to-r from-violet-500 to-purple-600 text-white px-3.5 py-1.5 rounded-xl hover:shadow-lg hover:shadow-violet-500/20 transition-all"
          >
            Upgrade
          </Link>
        )}
        <UserButton
          appearance={{ elements: { userButtonPopoverActionButton__manageAccount: { display: "none" } } }}
        >
          <UserButton.MenuItems>
            <UserButton.Link label="Settings" labelIcon={<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>} href="/settings" />
          </UserButton.MenuItems>
        </UserButton>
      </div>

      <div className="max-w-[480px] w-full space-y-10">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <Image src="/logo.png" alt="Know" width={56} height={56} priority className="rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-[28px] font-bold tracking-[-0.04em] text-gray-900">{greeting}</h1>
            <p className="text-gray-600 text-[15px]">
              Upload a paper to start learning
            </p>
          </div>
        </div>

        {/* Upload zone */}
        <div
          {...getRootProps()}
          className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-300 ${
            isDragActive
              ? "border-violet-300 bg-violet-50/30 scale-[1.01] shadow-lg shadow-violet-500/5"
              : "border-white/30 glass-subtle hover:bg-white/60 hover:border-white/40"
          } ${loading ? "opacity-50 pointer-events-none" : ""}`}
        >
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <input {...getInputProps()} />
            {loading ? (
              <div className="space-y-4 text-center animate-fade-in">
                <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-600 rounded-full animate-spin mx-auto" />
                <div>
                  <p className="text-[14px] text-gray-600 font-medium">Processing with AI...</p>
                  <p className="text-[12px] text-gray-400 mt-1">
                    Extracting text &amp; formatting equations (~20s)
                  </p>
                </div>
              </div>
            ) : isDragActive ? (
              <p className="text-[15px] font-medium text-gray-600">Drop here</p>
            ) : (
              <div className="text-center space-y-3">
                <div className="w-11 h-11 rounded-xl glass flex items-center justify-center mx-auto">
                  <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[15px] font-medium text-gray-800">Drop a PDF or click to browse</p>
                  <p className="text-[13px] text-gray-500 mt-0.5">arXiv, Nature, Science, PRL...</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="text-[13px] text-red-500 text-center animate-fade-in">{error}</p>
        )}

        {/* Recent papers */}
        {papers.length > 0 && (
          <div className="space-y-3 animate-fade-in">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-[12px] text-gray-400 uppercase tracking-[0.15em] font-semibold">
                Recent
              </h2>
              <button
                onClick={() => router.push("/library")}
                className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium"
              >
                View all &rarr;
              </button>
            </div>

            <div className="glass rounded-2xl divide-y divide-black/[0.06] overflow-hidden">
              {papers.slice(0, 3).map((p) => (
                <button
                  key={p.id}
                  onClick={() => router.push(`/paper/${p.id}`)}
                  className="w-full text-left px-4 py-3.5 hover:bg-white/40 transition-colors group"
                >
                  <p className="text-[14px] truncate font-medium text-gray-800 leading-snug group-hover:text-gray-900">{p.title || `paper-${p.id}`}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {p.folder && (
                      <span className="text-[10px] text-gray-400 bg-gray-50 border border-gray-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                        </svg>
                        {p.folder}
                      </span>
                    )}
                    {p.authors?.length > 0 && (
                      <span className="text-[11px] text-gray-400 truncate">
                        {p.authors.slice(0, 2).join(", ")}{p.authors.length > 2 ? " et al." : ""}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Footer nav */}
        <div className="flex items-center justify-center gap-8 pt-4">
          <button
            onClick={() => router.push("/library")}
            className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium"
          >
            Library
          </button>
          <button
            onClick={() => router.push("/settings")}
            className="text-[12px] text-gray-500 hover:text-gray-700 transition-colors font-medium"
          >
            Settings
          </button>
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

      <UpgradeModal
        tier={tierUser?.tier || "scholar"}
        open={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
      />
      <FeedbackModal open={showFeedback} onClose={() => setShowFeedback(false)} />
    </main>
  );
}
