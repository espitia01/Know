# Know — implementation briefing #8 for Composer 2.5

> **Scope**: three workspace polish items that came out of PROMPT_7's GA push for Researcher-tier multi-paper sessions. None of them are blocking but together they close the last visible "this is weird" gaps in the workspace UX:
>
> 1. **Unpinned-paper banner** — when the active paper isn't in the session bar (URL navigation to a paper while the 3-tab cap is full), tell the user explicitly. Right now the auto-add silently no-ops and the user sees a paper in the reader that isn't in their tabs, with no explanation.
> 2. **Legacy oversized workspaces** — saved workspaces predating the 3-paper cap may have 4+ papers. Today they truncate to the first 3 with no notice. Surface the truncation so users can choose which 3 to keep.
> 3. **Cross-paper QA result provenance** — the Cross-paper tab shows results from a single global array that doesn't know which set of papers each answer was generated against. Membership changes (add/remove a paper) leave stale answers in view, and reloads wipe the history entirely.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4. Workspace state lives in `frontend/src/lib/store.ts`. The Cross-paper tab is mounted at `frontend/src/components/panel/BottomPanel.tsx::AnalysisPanel`, rendering `frontend/src/components/sidebar/CrossPaperPanel.tsx`. Session cap constants are in `frontend/src/lib/workspaceFeatureFlags.ts` (`MAX_SESSION_PAPERS = 3`).
>
> **Rules to keep in mind** — read first:
> - `.cursor/rules/analysis-pane.mdc` (no new tokens, ≤200 LOC `BottomPanel`, primitives only)
> - `.cursor/rules/architecture.mdc` (streaming on Next, batch on Python, never local model)
> - `.cursor/rules/latex.mdc` (migrated paths use `$...$` / `$$...$$` markdown inside Streamdown)
>
> **Test plan**: after each track, `cd frontend && npm run lint && npm run build`. Manually verify each surface by walking the scenarios in the QA checklist.
>
> **Order**: A → B → C. A is trivial chrome, B is workspace-load polish, C is the heaviest because it touches the cross-paper result schema.

---

## Snapshot of the offending surfaces

| Concern | Files |
|---|---|
| Unpinned-paper banner above the session bar | `frontend/src/app/paper/[id]/page.tsx`, `frontend/src/components/header/SessionTabs.tsx` (extract if it doesn't exist yet) |
| Legacy oversized workspace open flow | `frontend/src/app/paper/[id]/page.tsx::handleLoadWorkspace`, `frontend/src/app/library/page.tsx::handleOpenWorkspace`, `frontend/src/components/workspaces/WorkspaceTruncationModal.tsx` (new) |
| Cross-paper QA provenance + persistence | `frontend/src/lib/store.ts`, `frontend/src/components/sidebar/CrossPaperPanel.tsx`, `frontend/src/lib/api.ts` (CrossPaperQA type), `backend/app/api/workspaces.py` (saved-workspace persistence) |

Do **not** revert PROMPT_3/4/5/6/7 patterns. Build on top.

---

## Track A — visible "unpinned paper" banner

### Reported symptom
> "URL-driven `addSessionPaper` is silently no-op at the cap. If the user navigates to a paper while the workspace is full, the session tab bar doesn't include it — but the reader does, and there's no explanation."

### Root cause
`addSessionPaper` returns `false` when `sessionPapers.length >= MAX_SESSION_PAPERS` and the paper isn't already pinned. The URL-driven `useEffect` in `paper/[id]/page.tsx` that fires on `paper?.id` change calls `addSessionPaper(...)` without checking the return — silent no-op. The user sees the active paper render but the session bar shows three different tabs. Nothing tells them why.

### Required fix

#### A1. Compute "is this paper pinned?" once at the top of the reader page

In `frontend/src/app/paper/[id]/page.tsx`, after the existing `sessionPapers` selector:
```ts
const isActivePinned = useMemo(
  () => sessionPapers.some((p) => p.id === activePaperId),
  [sessionPapers, activePaperId],
);
const workspaceFull = sessionPapers.length >= MAX_SESSION_PAPERS;
const showUnpinnedBanner =
  !!activePaperId && !isActivePinned && workspaceFull;
```

#### A2. Render a small banner directly above the session tab bar

Place it in the same chrome row as the session tabs — above the PDF viewer, below the top navbar. Use existing primitives only (no new design tokens):

```tsx
{showUnpinnedBanner && (
  <div
    role="status"
    className="flex items-center justify-between gap-3 border-b border-border/45 bg-muted/[0.08] px-4 py-2 text-[var(--text-xs)] text-muted-foreground/90"
  >
    <span>
      This paper isn’t in your workspace yet — your session is full ({MAX_SESSION_PAPERS} of {MAX_SESSION_PAPERS}). Remove a tab to pin it.
    </span>
    <span className="shrink-0 font-medium text-muted-foreground/70">
      {sessionPapers.length} / {MAX_SESSION_PAPERS}
    </span>
  </div>
)}
```

#### A3. One-click "Replace which tab?" affordance (small enhancement)

Add a `<button>` on the right side of the banner that opens a tiny popover listing the current session tabs with an "X" against each one. Clicking removes that tab AND immediately pins the active paper.

```tsx
const [pickerOpen, setPickerOpen] = useState(false);
// ...
<button
  type="button"
  onClick={() => setPickerOpen((v) => !v)}
  className="rounded-md border border-border/55 bg-background/80 px-2.5 py-1 text-[var(--text-xs)] font-semibold text-foreground/90 transition-colors hover:border-border-strong hover:bg-accent/35"
>
  Pin this paper…
</button>
```

The popover renders inside a portal (use the existing `OverflowMenu` primitive) and on selection:
```ts
removeSessionPaper(droppedId);
addSessionPaper({ id: activePaperId!, title: paper?.title ?? "Untitled" });
```

#### A4. Acceptance

- Session full with `[A, B, C]` active on A → click a Library entry for paper D → reader opens D, banner appears above tabs reading "This paper isn’t in your workspace yet — your session is full (3 of 3). Remove a tab to pin it." Pin-this-paper picker lists A, B, C; clicking a tab swaps it out and pins D.
- Removing a tab from `[A, B, C]` while A is active → banner disappears (workspace no longer full).
- Single-paper session (cap not reached) → banner never appears.
- Free / Scholar tier (no workspace chrome) → banner never appears (the session bar itself is hidden).

---

## Track B — handle legacy workspaces with > 3 papers

### Reported symptom
> "Saved workspaces with > 3 papers (legacy data) silently truncate to the first 3 on open."

### Root cause
`handleLoadWorkspace` in `paper/[id]/page.tsx` and `handleOpenWorkspace` in `library/page.tsx` both loop `addSessionPaper` for every paper id in the saved workspace. After the cap landed, the 4th+ paper silently returns `false`. The user opens W1 expecting 5 tabs and gets 3 with no notice — and the dropped 2 may be the ones they used most.

### Required fix

#### B1. Detect truncation and surface a one-shot modal

In both `handleLoadWorkspace` / `handleOpenWorkspace`, after the load loop:
```ts
const requested = ws.paper_ids.length;
const willPin = Math.min(loaded.length, MAX_SESSION_PAPERS);
const willDrop = Math.max(0, loaded.length - MAX_SESSION_PAPERS);
if (willDrop > 0) {
  setWorkspaceTruncation({
    workspace: ws,
    loaded,            // resolved {id, title}[] for every paper still in the library
    requested,
    cap: MAX_SESSION_PAPERS,
  });
  return; // don't pin yet — the modal owns the pinning step
}
```

#### B2. New modal component

`frontend/src/components/workspaces/WorkspaceTruncationModal.tsx`:
- Title: "This workspace has more papers than your session can hold"
- Body: "This workspace has **{requested} papers** but a workspace session holds at most **{cap}**. Pick the {cap} you want to load — the rest stay saved in the workspace."
- Body II (interactive): a `<ul>` with one row per paper, each row has a checkbox. Default-checked: the first `cap` papers. Disable the checkbox once `cap` are already selected (so the user can't pick a 4th). Each row shows the paper title with a truncation ellipsis at ~50 chars and a small chip with the original index in the saved workspace.
- Footer: `[Cancel]` `[Open with selected]` (primary). On confirm, the modal calls `onConfirm(selectedIds)` which the parent uses to do `clearSession(); for (const p of selectedIds) addSessionPaper(p);` and navigate to the first.

#### B3. Persist the user's choice for next time (optional polish)

If the user repeatedly opens an oversized workspace, asking them every time is annoying. Add a "Remember this choice" checkbox in the modal. When set, persist a `workspace_id → selected_paper_ids` map in localStorage (`know-workspace-truncation-prefs`) and bypass the modal on subsequent opens until the workspace's `updated_at` changes.

#### B4. Acceptance

- Open a saved workspace with 5 papers → modal lists all 5, first 3 pre-checked, user can re-select.
- Modal confirm with 3 selected → session loads exactly those 3 in order, navigates to the first.
- Modal cancel → no session change, user stays on the previous active paper.
- Workspace with ≤ 3 papers → modal never appears, current behavior preserved.
- "Remember choice" → next open of the same workspace (same `updated_at`) skips the modal.

---

## Track C — cross-paper QA result provenance and persistence

### The thinking
The Cross-paper tab in the analysis pane reads `crossPaperResults: { question, answer }[]` — a single global array. The panel doesn't know which set of papers any given result was generated against. Three concrete failure modes:

1. **Stale-membership confusion**: User has `[A, B, C]`, asks "compare", gets an answer that references "Paper C does X." User removes C. Session is now `[A, B]`. The answer is still visible, still says "Paper C does X" — but C isn't in the workspace anymore.
2. **Silent ambiguity across membership changes**: User asks "compare" in `[A, B]`, then adds C and asks again. Both answers show in chronological order. The first answer only had `[A, B]` context; the second had `[A, B, C]`. No metadata tells the user which set produced which answer.
3. **Reload loss**: `crossPaperResults` is NOT in the persisted `partialize`, so a refresh loses every cross-paper answer. `sessionPapers` IS persisted, so the session restores around an empty Cross-paper tab.

### Required fix

#### C1. Add a session signature to every cross-paper result

In `frontend/src/lib/api.ts` (where `CrossPaperQA` is typed):
```ts
export interface CrossPaperQA {
  question: string;
  answer: string;
  /** Sorted paper IDs in the session at the time this question was asked. */
  asked_against?: string[];
  /** Display-only: paper titles indexed to match `asked_against`. */
  asked_against_titles?: string[];
  /** Unix ms timestamp the answer was generated. */
  created_at?: number;
}
```

These fields are optional so existing payloads (saved workspaces, legacy localStorage) still parse.

#### C2. Stamp the signature when the result is added

In `frontend/src/components/sidebar/CrossPaperPanel.tsx::handleAsk`, before `addCrossPaperResults(answers)`:
```ts
const ids = [...paperIds].sort();
const titlesById = new Map(sessionPapers.map((p) => [p.id, p.title]));
const answers = res.items.map((item) => ({
  question: item.question,
  answer: item.answer,
  asked_against: ids,
  asked_against_titles: ids.map((id) => titlesById.get(id) ?? "Unknown paper"),
  created_at: Date.now(),
}));
```

#### C3. Render the signature inline with each result

In the result list inside `CrossPaperPanel`:
```tsx
const currentSig = [...sessionPapers.map((p) => p.id)].sort().join(",");
// ...
{crossPaperResults.map((r, i) => {
  const sig = (r.asked_against ?? []).join(",");
  const stale = sig && sig !== currentSig;
  return (
    <div key={i} className="space-y-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
      <p className="text-[var(--text-md)] font-medium text-foreground">{r.question}</p>
      {r.asked_against_titles && r.asked_against_titles.length > 0 && (
        <p className="text-[var(--text-xs)] text-muted-foreground/75">
          Asked against:{" "}
          {r.asked_against_titles
            .map((t) => (t.length > 28 ? t.slice(0, 28) + "…" : t))
            .join(", ")}
          {stale && (
            <span className="ml-1.5 rounded-md border border-border/55 bg-muted/[0.10] px-1.5 py-0.5 text-[var(--text-xs)] uppercase tracking-[0.06em] text-muted-foreground/80">
              Different papers
            </span>
          )}
        </p>
      )}
      <StreamingMarkdown>{r.answer}</StreamingMarkdown>
    </div>
  );
})}
```

#### C4. Persist the cross-paper history across reloads

In `frontend/src/lib/store.ts::partialize`, add:
```ts
crossPaperResults: state.crossPaperResults,
```

Cap the persisted array at 80 items (already enforced by `addCrossPaperResults`). Document the size in a comment.

#### C5. Active-paper switch should NEVER touch `crossPaperResults`

It already doesn't (the Cross-paper tab is workspace-scoped, not paper-scoped) — keep it that way. Add a one-line comment on the store action to make the contract explicit:
```ts
// `crossPaperResults` is intentionally NOT per-paper. The Cross-paper
// tab shows the workspace's QA history across every active paper.
// Membership-staleness is handled at render time via `asked_against`.
```

#### C6. Backend persistence is already correct

`backend/app/api/workspaces.py` accepts arbitrary objects in `cross_paper_results`, so the new `asked_against` / `asked_against_titles` / `created_at` fields ride through without a migration. Optional: add a one-line schema doc in the route handler so future readers know what's in there.

#### C7. Acceptance

- Session `[A, B, C]` → ask "compare" → answer card shows "Asked against: Paper A, Paper B, Paper C" subline.
- Remove paper C → answer stays visible, subline now ends with **"DIFFERENT PAPERS"** chip.
- Add paper D (now `[A, B, D]`) → ask a new question → its subline shows A, B, D; the previous answer still shows the stale chip.
- Reload the browser → both answers + sublines + chips restored from localStorage.
- Open a saved workspace with cross-paper results that **lack** the new fields → renders without sublines (no crash, no warning).

---

## Edge cases to keep in mind

1. **Empty session signature**: very early in render `sessionPapers` may be `[]`. `[].sort().join(",")` = `""`. A historical result with `asked_against = ["a","b"]` would compare to `""` and show as stale. Acceptable — once the session hydrates from localStorage, it stabilises in ~1 paint.
2. **Saved-workspace open with truncation modal AND stale cross-paper results**: open W1 (5 papers, has cross-paper results). Modal opens, user picks 3 of 5. After confirm, the cross-paper results that were generated against the original 5 get loaded. They'll show "DIFFERENT PAPERS" chips — that's correct.
3. **User clears cross-paper history**: existing "Clear" button on the Cross-paper panel should keep working — it nukes `crossPaperResults` and the localStorage slot via the existing `clearCrossPaperResults` action.
4. **Anonymous trial flow (`/try`)**: untouched. The trial reader doesn't have a workspace.
5. **Banner + truncation modal interaction**: while the truncation modal is open, the unpinned-paper banner from Track A must not be visible (the user hasn't picked a workspace yet). Suppress the banner with `if (workspaceTruncation) return null;` early in the reader render.
6. **Auto-add still silent for URL navigation**: per PROMPT_7, URL navigation deliberately doesn't try to evict. With the banner from Track A, the user is no longer surprised — the banner is the explicit signal.
7. **Saved workspaces with `paper_ids.length > MAX_SESSION_PAPERS` AND some papers missing from the library**: today's `loaded` array filters out missing papers before checking length. Make sure the modal's "Pick which 3" list shows only the actually-loadable papers and surfaces the missing-paper count separately ("2 papers in this workspace have been deleted").

---

## Final QA checklist

- [ ] `npm run lint` + `npm run build` pass.
- [ ] Researcher tier, 3 papers pinned, navigate to a library paper not in session → unpinned banner appears with "Pin this paper…" CTA.
- [ ] Click "Pin this paper…" → popover lists current tabs → clicking one swaps it for the active paper.
- [ ] Open a saved workspace with 5 papers → truncation modal lists all 5; default-checked are the first 3; cannot select more than 3; cancel leaves session unchanged; confirm loads exactly the chosen 3.
- [ ] Workspace with ≤ 3 papers opens immediately, no modal.
- [ ] In the Cross-paper tab, every result has an "Asked against" subline listing the papers it ran against.
- [ ] Removing a session paper marks affected results with the "Different papers" chip.
- [ ] Reload preserves cross-paper history with chips.
- [ ] No regressions in PROMPT_3/4/5/6/7 features.

---

## Notes for the implementer

- Track A is ~80 lines of chrome + the popover. Track B is ~150 lines (mostly the modal). Track C is the biggest because it touches schema + render + persist + saved workspaces. Ship as one commit or three — your call.
- The `OverflowMenu` primitive can host the "Pin this paper…" popover without adding new portal logic.
- Test against a freshly-created saved workspace AND against the legacy 5+ paper saved workspaces if any exist in your dev account. If you don't have any, fabricate one in Supabase to verify the modal — that's faster than mocking.
- Don't backfill `asked_against` for existing rows. Render-time defensiveness (the `?? []` in C3) is enough.
