"use client";

import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import type { QASourceHit } from "@/lib/api";

interface Props {
  /** Active paper id for single-paper Q&A panels. Used to decide whether
   *  clicking a chip needs to switch papers first. Cross-paper panel can
   *  omit this and rely on `sessionPapers`. */
  paperId?: string;
  sources?: QASourceHit[];
  sessionPapers?: { id: string; title: string }[];
}

const MAX_CHIPS = 6;

function shortLabel(s: QASourceHit, fallbackIndex: number): string {
  if (s.section && s.section.trim()) return s.section.trim().slice(0, 30);
  return `passage ${fallbackIndex + 1}`;
}

export function QASourceChips({ paperId, sources, sessionPapers }: Props) {
  const router = useRouter();
  const setPendingPassage = useStore((s) => s.setPendingPassage);
  const setActivePaperId = useStore((s) => s.setActivePaperId);

  if (!sources || sources.length === 0) return null;
  const limited = sources.slice(0, MAX_CHIPS);

  const handleClick = (hit: QASourceHit) => {
    if (!hit.snippet) return;
    const targetPaperId = hit.paper_id;
    if (paperId && targetPaperId && targetPaperId !== paperId) {
      // Cross-paper case: hand the active paper off, then queue the passage
      // so it fires after the new PdfViewer mounts.
      setActivePaperId(targetPaperId);
      setPendingPassage(targetPaperId, {
        snippet: hit.snippet,
        paper_id: targetPaperId,
        ts: Date.now(),
      });
      router.replace(`/paper/${targetPaperId}`);
      return;
    }
    const target = targetPaperId || paperId;
    if (!target) return;
    setPendingPassage(target, {
      snippet: hit.snippet,
      paper_id: target,
      ts: Date.now(),
    });
  };

  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Sources">
      {limited.map((hit, i) => {
        const paperTitle = sessionPapers?.find((p) => p.id === hit.paper_id)?.title;
        const showPaperPrefix =
          sessionPapers && paperTitle && hit.paper_id && hit.paper_id !== paperId;
        const sim = typeof hit.similarity === "number" ? Math.round(hit.similarity * 100) : null;
        return (
          <button
            key={`${hit.paper_id}-${hit.chunk_index}-${i}`}
            type="button"
            onClick={() => handleClick(hit)}
            title={hit.snippet}
            className="inline-flex max-w-[18rem] items-center gap-1 truncate rounded-md border border-border/55 bg-muted/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/85 transition-colors motion-safe:duration-150 hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="tabular-nums">{i + 1}.</span>
            {showPaperPrefix && (
              <span className="truncate text-foreground/75">
                {paperTitle!.length > 18 ? `${paperTitle!.slice(0, 18)}…` : paperTitle}
              </span>
            )}
            <span className="truncate">{shortLabel(hit, i)}</span>
            {sim != null && <span className="text-muted-foreground/60">· {sim}%</span>}
          </button>
        );
      })}
    </div>
  );
}
