"use client";

import { useCallback, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => {
      const ua = navigator.userAgent;
      setIsMobile(/iPhone|iPod|Android(?!.*Tablet)|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua) && window.innerWidth < 768);
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
    <div className="min-h-screen bg-white">
      {/* Trial banner */}
      <div className="bg-gray-900 text-center py-2.5 px-4">
        <p className="text-[13px] text-gray-300">
          Trial mode — upload a paper to preview its summary.{" "}
          <Link href="/sign-up" className="text-white font-medium hover:underline">
            Sign up free
          </Link>{" "}
          for full access.
        </p>
      </div>

      {/* Nav */}
      <nav className="border-b border-gray-100 bg-white">
        <div className="max-w-6xl mx-auto px-6 h-[56px] flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.png" alt="Know" width={24} height={24} className="rounded-md" />
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-gray-900">Know</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/sign-in"
              className="text-[13px] font-medium text-gray-500 hover:text-gray-900 transition-colors px-3 py-1.5"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="text-[13px] font-medium bg-gray-900 text-white px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex flex-col items-center p-6 pt-[12vh]">
        <div className="max-w-[480px] w-full space-y-10">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <Image src="/logo.png" alt="Know" width={56} height={56} priority className="rounded-xl" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-[28px] font-bold tracking-[-0.04em] text-gray-900">Try Know</h1>
              <p className="text-gray-500 text-[15px]">
                Upload a paper to see a detailed AI summary — no account needed.
              </p>
            </div>
          </div>

          {isMobile ? (
            <div className="text-center py-16 px-6 rounded-2xl border border-gray-200 bg-gray-50/50">
              <div className="w-11 h-11 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center mx-auto mb-4">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                </svg>
              </div>
              <h2 className="text-[17px] font-semibold text-gray-900 mb-1.5">Coming soon to mobile</h2>
              <p className="text-[14px] text-gray-500 max-w-[280px] mx-auto">
                Know works best on a desktop browser. Please visit us on your PC for the full experience.
              </p>
              <Link
                href="/sign-up"
                className="inline-block mt-6 text-[13px] font-medium bg-gray-900 text-white px-5 py-2.5 rounded-lg hover:bg-gray-800 transition-colors"
              >
                Create an account for later
              </Link>
            </div>
          ) : (
          <>
          <div
            {...getRootProps()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all duration-300 ${
              isDragActive
                ? "border-gray-400 bg-gray-50 scale-[1.01]"
                : "border-gray-200 hover:border-gray-300 hover:bg-gray-50/50"
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
                      Extracting text &amp; generating summary (~20s)
                    </p>
                  </div>
                </div>
              ) : isDragActive ? (
                <p className="text-[15px] font-medium text-gray-500">Drop here</p>
              ) : (
                <div className="text-center space-y-3">
                  <div className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center mx-auto">
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-[15px] font-medium text-gray-800">Drop a PDF or click to browse</p>
                    <p className="text-[13px] text-gray-400 mt-0.5">One paper in trial mode</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {error && (
            <p className="text-[13px] text-red-500 text-center animate-fade-in">{error}</p>
          )}
          </>
          )}
        </div>
      </main>
    </div>
  );
}
