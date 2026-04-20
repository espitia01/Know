"use client";

import { useCallback, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

export default function TrialPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const isMobile = useIsMobile();

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      setError("");
      setLoading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`${API_BASE}/api/trial/upload`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Upload failed: ${detail}`);
        }
        const paper = await res.json();
        router.push(`/try/${paper.id}`);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setLoading(false);
      }
    },
    [router]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
  });

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Trial banner */}
      <div className="bg-foreground text-background text-center py-2.5 px-4">
        <p className="text-[13px] opacity-90">
          Trial mode — upload a paper to preview its summary.{" "}
          <Link href="/sign-up" className="underline underline-offset-2 font-medium">
            Sign up free
          </Link>{" "}
          for full access.
        </p>
      </div>

      {/* Nav */}
      <nav className="border-b border-border glass-nav">
        <div className="max-w-6xl mx-auto px-6 h-[56px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 ring-focus rounded-md">
            <Image src="/logo.png" alt="Know" width={24} height={24} className="rounded-md" />
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-foreground">Know</span>
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/sign-in"
              className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="text-[13px] font-medium btn-primary-glass px-4 py-2 rounded-lg"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex flex-col items-center p-6 pt-[10vh] bg-mesh">
        <div className="max-w-[480px] w-full space-y-10">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <Image src="/logo.png" alt="Know" width={56} height={56} priority className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-[28px] font-bold tracking-[-0.04em] text-foreground">Try Know</h1>
              <p className="text-muted-foreground text-[15px] text-pretty">
                Upload a paper to see a detailed AI summary — no account needed.
              </p>
            </div>
          </div>

          {isMobile ? (
            <div className="text-center py-16 px-6 rounded-2xl border border-border bg-card/60 glass-subtle">
              <div className="w-11 h-11 rounded-xl bg-accent border border-border flex items-center justify-center mx-auto mb-4">
                <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                </svg>
              </div>
              <h2 className="text-[17px] font-semibold text-foreground mb-1.5">Coming soon to mobile</h2>
              <p className="text-[14px] text-muted-foreground max-w-[280px] mx-auto text-pretty">
                Know works best on a desktop browser. Please visit us on your PC for the full experience.
              </p>
              <Link
                href="/sign-up"
                className="inline-block mt-6 text-[13px] font-medium btn-primary-glass px-5 py-2.5 rounded-lg"
              >
                Create an account for later
              </Link>
            </div>
          ) : (
            <>
              <div
                {...getRootProps()}
                className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-300 ring-focus ${
                  isDragActive
                    ? "border-border-strong bg-accent scale-[1.01]"
                    : "border-border hover:border-border-strong hover:bg-accent/50"
                } ${loading ? "opacity-50 pointer-events-none" : ""}`}
              >
                <div className="flex flex-col items-center justify-center py-16 px-6">
                  <input {...getInputProps()} />
                  {loading ? (
                    <div className="space-y-4 text-center animate-fade-in">
                      <div className="w-8 h-8 border-2 border-border border-t-foreground rounded-full animate-spin mx-auto" />
                      <div>
                        <p className="text-[14px] text-foreground font-medium">Processing with AI…</p>
                        <p className="text-[12px] text-muted-foreground mt-1">
                          Extracting text &amp; generating summary (~20s)
                        </p>
                      </div>
                    </div>
                  ) : isDragActive ? (
                    <p className="text-[15px] font-medium text-foreground">Drop here</p>
                  ) : (
                    <div className="text-center space-y-3">
                      <div className="w-11 h-11 rounded-xl bg-accent border border-border flex items-center justify-center mx-auto">
                        <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[15px] font-medium text-foreground">Drop a PDF or click to browse</p>
                        <p className="text-[13px] text-muted-foreground mt-0.5">One paper in trial mode</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {error && (
                <p className="text-[13px] text-destructive text-center animate-fade-in">{error}</p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
