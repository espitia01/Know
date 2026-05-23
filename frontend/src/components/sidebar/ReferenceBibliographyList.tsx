"use client";

import type { PriorWork } from "@/lib/api";
import { referenceDisplayLabel } from "@/lib/formatBibliography";
import { priorWorkExternalHref, referenceIndexLabel } from "@/lib/priorWorkLinks";

function ReferenceRow({ work, index }: { work: PriorWork; index: number }) {
  const href = priorWorkExternalHref(work);
  const label = referenceDisplayLabel(work);
  if (!label) return null;
  const indexLabel = referenceIndexLabel(work, index);

  const cls =
    "text-[var(--text-sm)] leading-relaxed text-foreground/90 underline-offset-[3px] hover:underline decoration-border/60";

  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-px shrink-0 w-6 text-right text-[var(--text-xs)] tabular-nums text-muted-foreground/70"
        aria-hidden
      >
        {indexLabel}.
      </span>
      <div className="min-w-0 flex-1 pt-px">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
            {label}
          </a>
        ) : (
          <span className="block text-[var(--text-sm)] leading-relaxed text-foreground/90">{label}</span>
        )}
      </div>
    </li>
  );
}

export function ReferenceBibliographyList({
  items,
  startIndex = 0,
}: {
  items: PriorWork[];
  startIndex?: number;
}) {
  const rows = items
    .map((p, i) => ({ p, i: startIndex + i + 1 }))
    .map(({ p, i }) => <ReferenceRow key={`${p.bib_label ?? p.ref_id ?? p.title}-${i}`} work={p} index={i} />)
    .filter(Boolean);

  if (!rows.length) {
    return (
      <p className="mt-3 text-[var(--text-sm)] text-muted-foreground/80">
        No clean bibliography entries could be parsed from this PDF.
      </p>
    );
  }

  return <ol className="mt-3 list-none space-y-2.5 p-0">{rows}</ol>;
}
