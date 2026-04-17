"use client";

import { useCallback, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useRouter } from "next/navigation";
import { api, PaperListEntry } from "@/lib/api";
import { useStore } from "@/lib/store";
import { AuthGuard } from "@/components/AuthGuard";

function HomeContent() {
  const router = useRouter();
  const { setPaper, loading, setLoading } = useStore();
  const [papers, setPapers] = useState<PaperListEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listPapers().then(setPapers).catch(() => {});
  }, []);

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

  return (
    <main className="flex-1 flex flex-col items-center p-6 pt-[14vh]">
      <div className="max-w-lg w-full space-y-8">
        <div className="text-center space-y-1.5">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Know</h1>
          <p className="text-muted-foreground text-[15px]">
            Upload a paper. Learn it properly.
          </p>
        </div>

        <div
          {...getRootProps()}
          className={`cursor-pointer rounded-xl border-2 border-dashed transition-all duration-200 ${
            isDragActive
              ? "border-foreground/50 bg-accent scale-[1.01]"
              : "border-border hover:border-foreground/20 hover:bg-accent/50"
          } ${loading ? "opacity-50 pointer-events-none" : ""}`}
        >
          <div className="flex flex-col items-center justify-center py-12 px-6">
            <input {...getInputProps()} />
            {loading ? (
              <div className="space-y-3 text-center animate-fade-in">
                <div className="w-6 h-6 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin mx-auto" />
                <div>
                  <p className="text-[14px] text-muted-foreground font-medium">Processing with AI...</p>
                  <p className="text-[12px] text-muted-foreground/60 mt-0.5">
                    Extracting text & formatting equations (~20s)
                  </p>
                </div>
              </div>
            ) : isDragActive ? (
              <p className="text-[15px] font-medium text-foreground/70">Drop here</p>
            ) : (
              <div className="text-center space-y-1.5">
                <svg className="w-8 h-8 mx-auto text-muted-foreground/40 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                </svg>
                <p className="text-[15px] font-medium">Drop a PDF or click to browse</p>
                <p className="text-[13px] text-muted-foreground">Nature, arXiv, Science, PRL...</p>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="text-[13px] text-destructive text-center animate-fade-in">{error}</p>
        )}

        {papers.length > 0 && (
          <div className="space-y-3 animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] text-muted-foreground uppercase tracking-widest font-semibold">
                Recent <span className="text-muted-foreground/50">{papers.length}</span>
              </h2>
              <button
                onClick={() => router.push("/library")}
                className="text-[12px] text-muted-foreground hover:text-foreground transition-colors font-medium"
              >
                View Library &rarr;
              </button>
            </div>

            <div className="space-y-0.5">
              {papers.slice(0, 5).map((p) => (
                <button
                  key={p.id}
                  onClick={() => router.push(`/paper/${p.id}`)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-accent transition-colors duration-150 group"
                >
                  <p className="text-[14px] truncate font-medium leading-snug">{p.title || `paper-${p.id}`}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {p.folder && <span className="text-[10px] text-muted-foreground/50 bg-muted px-2 py-0.5 rounded-full">{p.folder}</span>}
                    {p.tags?.slice(0, 3).map((t) => (
                      <span key={t} className="text-[10px] text-muted-foreground/50">#{t}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-center gap-4">
          {papers.length > 0 && (
            <button
              onClick={() => router.push("/library")}
              className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              Library
            </button>
          )}
          <button
            onClick={() => router.push("/settings")}
            className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            Settings
          </button>
        </div>
      </div>
    </main>
  );
}

export default function Home() {
  return <AuthGuard><HomeContent /></AuthGuard>;
}
