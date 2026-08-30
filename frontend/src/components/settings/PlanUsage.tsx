"use client";

const CAPABILITY_COPY: Record<string, { title: string; hint: string }> = {
  fast: {
    title: "Fast models",
    hint: "Haiku, GPT-5 mini, Mistral Small",
  },
  balanced: {
    title: "Standard models",
    hint: "Sonnet, GPT-5, Mistral Medium",
  },
  top: {
    title: "Advanced models",
    hint: "Opus, GPT-5.4, Mistral Large",
  },
};

export type AccountUsage = {
  tier: string;
  papers_used: number;
  papers_limit: number;
  daily_api_used: number;
  daily_api_limit: number;
  qa_per_paper_limit: number;
  selections_per_paper_limit: number;
  per_capability_usage: { capability: string; label: string; used: number; limit: number }[];
  daily_resets_at?: string;
};

function formatLimit(n: number): string {
  if (n === -1) return "Unlimited";
  return n.toLocaleString();
}

function formatReset(iso?: string): string {
  if (!iso) return "Resets daily at midnight UTC";
  try {
    const d = new Date(iso);
    return `Resets ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  } catch {
    return "Resets daily at midnight UTC";
  }
}

function UsageRow({
  label,
  used,
  limit,
  hint,
}: {
  label: string;
  used: number;
  limit: number;
  hint?: string;
}) {
  const unlimited = limit === -1;
  const pct = unlimited ? 0 : Math.min(100, limit > 0 ? (used / limit) * 100 : 0);
  const near = !unlimited && pct >= 80;
  const over = !unlimited && used >= limit && limit > 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{label}</p>
          {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
        </div>
        <p className="shrink-0 tabular-nums text-[12px] text-muted-foreground">
          {unlimited ? (
            <>
              <span className="font-medium text-foreground">{used.toLocaleString()}</span>
              <span> used</span>
            </>
          ) : (
            <span className={over ? "font-medium text-destructive" : near ? "font-medium text-warning" : "font-medium text-foreground"}>
              {used.toLocaleString()}
              <span className="font-normal text-muted-foreground"> / {formatLimit(limit)}</span>
            </span>
          )}
        </p>
      </div>
      {!unlimited && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${
              over ? "bg-destructive/70" : near ? "bg-warning" : "bg-foreground/80"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function PlanUsage({
  usage,
  periodEnd,
}: {
  usage: AccountUsage;
  periodEnd?: number | null;
}) {
  const caps = (usage.per_capability_usage || []).filter((row) => row.limit !== 0);
  const renewLabel = (() => {
    if (!periodEnd) return null;
    try {
      return new Date(periodEnd * 1000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          This cycle
        </p>
        {renewLabel && (
          <p className="text-[12px] text-muted-foreground">Renews {renewLabel}</p>
        )}
      </div>

      <div className="space-y-4">
        <UsageRow
          label="Library"
          used={usage.papers_used}
          limit={usage.papers_limit}
          hint="Papers you can keep uploaded"
        />
        <UsageRow
          label="AI requests today"
          used={usage.daily_api_used}
          limit={usage.daily_api_limit}
          hint={formatReset(usage.daily_resets_at)}
        />
      </div>

      {caps.length > 0 && (
        <div className="space-y-4 border-t border-border/40 pt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Today by model class
          </p>
          {caps.map((row) => {
            const copy = CAPABILITY_COPY[row.capability] ?? {
              title: `${row.label} models`,
              hint: undefined,
            };
            return (
              <UsageRow
                key={row.capability}
                label={copy.title}
                used={row.used}
                limit={row.limit}
                hint={copy.hint}
              />
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 border-t border-border/40 pt-4">
        <div className="rounded-lg border border-border/40 bg-muted/[0.08] px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">Q&amp;A per paper</p>
          <p className="mt-0.5 text-[14px] font-medium tabular-nums text-foreground">
            {formatLimit(usage.qa_per_paper_limit)}
          </p>
        </div>
        <div className="rounded-lg border border-border/40 bg-muted/[0.08] px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">Selections per paper</p>
          <p className="mt-0.5 text-[14px] font-medium tabular-nums text-foreground">
            {formatLimit(usage.selections_per_paper_limit)}
          </p>
        </div>
      </div>
    </div>
  );
}
