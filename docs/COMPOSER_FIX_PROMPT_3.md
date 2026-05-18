# Know — bug‑fix + polish briefing #3 for Composer 2.5

> **Scope**: six upgrades to the authenticated reader pane (`/paper/[id]`). One UX bug (the panel‑options menu doesn't open), one navigation cleanup, two observability/transparency improvements (which model produced what, and visibly variable output between Haiku / Sonnet / Opus), and two reader‑comfort additions (font family + denser, more readable analysis cards). Run an investigate → diagnose → fix → verify loop on each one. Stay inside `.cursor/rules/*.mdc` (analysis‑pane, architecture, latex). **Read those rules first.** Reuse the existing primitives — do **not** add new shadow tokens, motion durations, colors, or animation classes; any new className you add must already exist somewhere in the codebase or carry a one‑line comment justifying it.
>
> **Stack reminders that bit prior models**:
> - Next.js 16 file routing — verify behavior via `frontend/node_modules/next/dist/docs/` if unsure.
> - AI SDK v6 + Zod 4. `streamObject({ schema: zodSchema(z.object({...})) })` is mandatory.
> - `@ai-sdk/react`'s `experimental_useObject` is the streaming client — do not roll your own SSE parser.
> - Streaming UX (cursor, "streaming…" badge, pulse footer) lives **only** in `frontend/src/components/analysis/StreamingMarkdown.tsx`.
> - Math: `$...$` inline, `$$...$$` display — Streamdown's `@streamdown/math` plugin with `singleDollarTextMath: true`. The legacy `Md`/`preprocessLatex` chain is kept exclusively for the Notes path.
> - Visual language: card bg `bg-card/35 dark:bg-card/22`, chrome `bg-muted/[0.08]`, borders `border-border/50` (chrome `border-border/40`), section spacing `space-y-8`, inner `space-y-3`, list `space-y-2`, body `text-[var(--text-sm)]`, heading `font-display tracking-[-0.02em]`, motion `motion-safe:duration-150` only.
> - Models live in two places: the **slug** comes from `/api/internal/user/{id}/models` (Python `gating.py`), then `frontend/src/lib/server/llm.ts` routes via AI Gateway → Anthropic. Never duplicate `gating.py` logic in TypeScript.
>
> **Test plan**: after each bug, `npm run lint` + smoke. Don't open a PR until all five hit their acceptance criteria.

---

## Snapshot of the offending surfaces (read these first)

| Concern | Files |
|---|---|
| Pane options menu (font size + position) | `frontend/src/components/analysis/OverflowMenu.tsx`, `frontend/src/components/panel/BottomPanel.tsx` |
| Gear in reader navbar | `frontend/src/app/paper/[id]/page.tsx` (~L1782–L1791) |
| Model badges in every analysis surface | every stream route under `frontend/src/app/api/papers/[id]/*-stream/route.ts`, `frontend/src/lib/server/internalApi.ts`, `frontend/src/lib/api.ts` (types), every panel under `frontend/src/components/sidebar/*Panel.tsx` + `frontend/src/components/panel/SelectionResultPanel.tsx`, `frontend/src/components/panel/SectionHeader.tsx` |
| Output length tied to model tier | `frontend/src/app/api/papers/[id]/{summary,selection,figure-qa}-stream/route.ts`, `frontend/src/lib/server/prompts/*.ts`, `frontend/src/lib/server/llm.ts` |
| Analysis‑pane info design | `frontend/src/components/sidebar/{Summary,Assumptions,QA,Notes,Figures,PreReading,RelatedWork}Panel.tsx`, `frontend/src/components/panel/{SelectionResultPanel,SectionHeader,AnalysisAccordionRow}.tsx`, `frontend/src/components/analysis/{StreamingMarkdown,RichContent,AnalysisSection,AnalysisCard}.tsx`, `frontend/src/app/globals.css` (`.analysis-content`, `.analysis-pane-v2`) |
| Font family picker | `frontend/src/lib/store.ts`, `frontend/src/components/panel/BottomPanel.tsx` (OverflowMenu menu items), `frontend/src/app/globals.css` (`.analysis-content`) |

If something looks weird (e.g. a multi‑step word‑snap fallback with Safari/WebKit comments), the original author had a reason — refactor, don't rip.

---

## Bug 1 — "Panel options" menu (font size + pane position) doesn't open

### Reported symptom
The kebab/text‑size icon in the analysis‑pane tab strip header is unclickable. Hovering doesn't open the popup; clicking does nothing. Users can't change font scale or move the pane.

### Where to look
- `frontend/src/components/analysis/OverflowMenu.tsx` (~L20–L59). The trigger is wired with base‑ui's render prop:
  ```tsx
  <Popover.Trigger render={(props) => <span {...props}>{trigger}</span>} />
  ```
  The `trigger` slot is a real `<button type="button">` in `BottomPanel.tsx` (~L180–L207). So the actual DOM is **`<span role="button" ... ><button>icon</button></span>`** — a button nested inside a `[role=button]` span. base‑ui's pointerdown listener lives on the span; the inner `<button>` swallows the click because buttons stop the click from bubbling to non‑interactive ancestors on every browser we care about. (Verify with a `console.log` on the span's onClick before fixing — expect zero events.)
- Same anti‑pattern would apply to any other call site. **Grep for `<OverflowMenu` and audit every consumer** — for this batch the only one is `BottomPanel`, but the primitive needs to work everywhere.

### Required fix
1. Change `OverflowMenu`'s trigger contract: callers pass a **button** that base‑ui owns, not a span wrapper around their own button. The cleanest API:
   ```tsx
   <Popover.Trigger
     render={(triggerProps) => (
       <button type="button" {...triggerProps} {...buttonProps}>
         {triggerInner}
       </button>
     )}
   />
   ```
   Update the prop surface to accept `triggerInner: ReactNode` (the icon/label) and `buttonProps: ButtonHTMLAttributes<HTMLButtonElement>` (className, title, aria‑label, etc.). Spread `triggerProps` **first**, then the caller's `buttonProps`, so the caller's `aria-label` / `title` / `className` win without clobbering base‑ui's `onPointerDown` / `aria-haspopup` / `data-popup-open` / `aria-controls`.
2. Update `BottomPanel.tsx` to use the new contract: pass the inner SVG as `triggerInner`, the existing classes / titles / aria as `buttonProps`. **Do not** double‑wrap with a `<span>`.
3. While there, make sure the trigger button gets:
   - `aria-haspopup="menu"` (added by base‑ui via spread; verify with the DevTools accessibility tree).
   - Focus ring on keyboard activation (the existing `data-[popup-open]:bg-accent/60` stays, and base‑ui already adds focus management — just don't override `tabIndex`).
4. Test keyboard activation: Enter / Space on the trigger should open the menu; Escape should close it and return focus to the trigger.

### Acceptance criteria
- Clicking the kebab opens the menu. Touch tap works on iPad Safari.
- Keyboard: Tab to button, Enter/Space opens, Escape closes, focus returns to trigger.
- No regression in either appearance variant — `data-[popup-open]` background still applies.
- Aria tree: trigger is `role=button` with `aria-haspopup=menu`/`aria-expanded=true|false`; popup is `role=dialog` (base‑ui default).

---

## Bug 2 — Remove the redundant gear from the reader navbar

### Reported symptom
The reader header (`paper/[id]`) has both:
1. A standalone gear icon button that navigates to `/settings` (~L1782–L1791).
2. The Clerk `<UserButton>` dropdown, which already exposes a "Settings" item with the same gear icon (~L1795–L1797).

Two paths, same destination, both 18 px apart in the same top bar. The gear button is the duplicate — remove it.

### Where to look
- `frontend/src/app/paper/[id]/page.tsx`, the gear `<button onClick={() => router.push("/settings")}>` block immediately before `<UserButton>`.

### Required fix
1. Delete the standalone gear button (and any now‑unused imports, e.g. if `router.push` was only used by this and nothing else — likely not; verify).
2. Keep the `UserButton.MenuItems > UserButton.Link href="/settings"` block untouched; that stays the canonical entry point.
3. **Do not touch** the gear icon inside the `UserButton.Link.labelIcon` — that's the dropdown row icon and is correct.
4. **Do not touch** the dashboard navbar — that one's already correct (only `UserButton`'s Settings menu item, no separate gear).
5. **Do not touch** the Settings page header (`/settings`).

### Acceptance criteria
- Reader top bar shows: ThemeToggle, FocusMode, Hide/Show Analysis, UserButton — no standalone gear.
- Settings remains reachable via the avatar dropdown.
- No console errors, no orphan imports, lint clean.

---

## Bug 3 — Surface the model that produced each analysis ("not obvious which model is being used where")

### Reported symptom
> "I do not really see longer answers if we use Opus vs Haiku."

Two real problems baked into that:
1. **Visibility** — there is no indication anywhere in the UI of which model produced the artifact the user is reading. The Settings picker shows which model is *configured*, but selection/summary/figure responses don't say "Generated by Opus" anywhere, so users can't tell if their tier upgrade actually took effect.
2. **Output length** — `maxOutputTokens` is hard‑coded per route and identical regardless of which model the user picked. Haiku and Opus both cap at 8000/6000/4000 (selection / summary / figure). So even when Opus is selected, the response can look similar in length because nothing in the prompt or budget asks for deeper output.

Fix both: badge the model on every analysis card, **and** widen the output budget + prompt depth instructions when the user is paying for a heavier model.

### Where to look — Part A (model badge plumbing)
- `frontend/src/app/api/papers/[id]/summary-stream/route.ts` — has `analysisModel` resolved at L71. Doesn't surface it to the client or persist it.
- `frontend/src/app/api/papers/[id]/selection-stream/route.ts` — has `fastModel` at L148. Same gap.
- `frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts` — has `fastModel` at L102. Same gap.
- `frontend/src/lib/api.ts` — `SelectionAnalysisResult`, `PaperSummary`, `FigureAnalysis` types. Need a new optional `model?: string` field.
- `frontend/src/lib/server/schemas.ts` — Zod schemas for `SelectionResult` / `PaperSummary` / `FigureAnalysis`. Add `model: z.string().optional()` so the persisted cache can round‑trip.
- `frontend/src/components/sidebar/*Panel.tsx` + `frontend/src/components/panel/SelectionResultPanel.tsx` — render the badge.

### Required fix — Part A: plumbing
1. **Response header.** Each migrated stream route should set a custom header so the client knows the model **before** the body even starts streaming. Example for `summary-stream/route.ts`:
   ```ts
   return result.toTextStreamResponse({
     headers: {
       "Content-Type": "text/plain; charset=utf-8",
       "Cache-Control": "no-store, no-transform",
       "X-Accel-Buffering": "no",
       "X-Know-Model": analysisModel,
     },
   });
   ```
   Do the same for `selection-stream` (`fastModel`) and `figure-qa-stream` (`fastModel`). Header name **must** be `X-Know-Model` so callers don't have to remember which route uses which env var.
2. **Persist on the final object.** Inside each route's `onFinish`, attach `model` to the cached payload so the badge survives a reload:
   ```ts
   await upsertCachedAnalysis({
     userId: user.userId,
     paperId,
     key: "summary",
     value: { ...finalObject, overview, model: analysisModel },
   });
   ```
   For `selections` and `figure_analyses` (append‑capped arrays), include `model` in each entry. For figure analysis the model goes on the cached entry alongside `figure_id` / `question`.
3. **Client wiring.** Where streams are consumed:
   - `useSelectionThread` / selection‑stream hook → on the `response` callback (the stream wrapper exposes `response.headers`), read `X-Know-Model` and merge into the streaming `SelectionAnalysisResult` as `model`. Then `upsertSelectionInHistory` carries it through.
   - `useSummaryStream` → same idea: pluck the header, store on the assembled `PaperSummary`.
   - `FiguresPanel.handleAnalyze` (~L334–L420) → fetch the stream `Response` directly (it already does), read `res.headers.get("X-Know-Model")`, save into the streaming/final assistant message metadata.
4. **Type widening.** Add optional `model?: string` to:
   - `SelectionAnalysisResult` in `frontend/src/lib/api.ts`.
   - `PaperSummary` in `frontend/src/lib/api.ts`.
   - `FigureAnalysis` in `frontend/src/lib/api.ts`.
   - Matching Zod schemas in `frontend/src/lib/server/schemas.ts` (use `.optional()` to keep older cached entries valid).
5. **No Python changes** — the slug is already returned by `/api/internal/user/{id}/models`. Just plumb it forward.

### Required fix — Part B: friendly labels + visual badge

1. **Centralize labels.** Add `frontend/src/lib/modelLabels.ts`:
   ```ts
   export const MODEL_LABEL: Record<string, { short: string; tone: "amber" | "violet" | "blue" }> = {
     "claude-haiku-4-5": { short: "Haiku", tone: "blue" },
     "claude-sonnet-4-6": { short: "Sonnet", tone: "violet" },
     "claude-opus-4-7": { short: "Opus", tone: "amber" },
   };
   export function modelLabel(slug?: string | null): { short: string; tone: "amber" | "violet" | "blue" } {
     if (!slug) return { short: "Model", tone: "blue" };
     return MODEL_LABEL[slug] ?? { short: slug.replace(/^claude-/, "").replace(/-\d.*$/, ""), tone: "blue" };
   }
   ```
   Reuse `[data-action]` tints from `globals.css` (`--highlight-rgb` blue / violet / amber) — **do not introduce a new color token**. The `tone` field just maps to the existing `data-action` keys (`explain` = blue, `derive` = violet, `assumptions` = amber). Render via a single pill component.
2. **New pill primitive.** `frontend/src/components/analysis/ModelPill.tsx`:
   ```tsx
   export function ModelPill({ slug, className }: { slug?: string | null; className?: string }) {
     if (!slug) return null;
     const { short, tone } = modelLabel(slug);
     const dataAction = tone === "amber" ? "assumptions" : tone === "violet" ? "derive" : "explain";
     return (
       <span
         data-action={dataAction}
         className={cn(
           "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium tracking-[0.04em] text-foreground/80",
           "border border-border/55 bg-muted/30",
           className,
         )}
         title={`Generated by ${slug}`}
       >
         <span
           aria-hidden
           className="h-1.5 w-1.5 rounded-full"
           style={{ background: "rgb(var(--highlight-rgb) / 0.85)" }}
         />
         {short}
       </span>
     );
   }
   ```
   No new colors — `--highlight-rgb` comes from the existing `data-action` rules.
3. **Where to render the pill.** Slot it into existing `SectionHeader` instances and result cards (not as a new chunk of layout — it goes in the existing `action` slot of `SectionHeader`, or in the header row of a card). One pill per card, top‑right.
   - `SummaryPanel` header row (next to the section title "Summary").
   - `SelectionResultPanel.ResultCard` header (next to the action label like "Explain"). Replace nothing; just append.
   - `AssumptionsPanel` header.
   - `QAPanel` per Q&A row header.
   - `FiguresPanel` detail view header.
   - `PreReadingPanel` heading row.
   - `RelatedWorkPanel` heading row.
   - `NotesPanel` — Notes go through Python (not migrated), and the polish path doesn't have a model header today. **Skip for now**; leave a TODO comment referencing this rule.
4. **Empty state.** When `model` is missing from a cached entry (old data), `ModelPill` renders nothing — never a confusing fallback like "Model" with no slug.

### Required fix — Part C: actually make Opus produce longer / deeper output

1. **Per‑model output budget.** In `frontend/src/lib/server/llm.ts`, add:
   ```ts
   export function maxOutputTokensFor(slug: string, role: ModelRole): number {
     const isOpus = slug.includes("opus");
     const isSonnet = slug.includes("sonnet");
     if (role === "analysis") return isOpus ? 12000 : isSonnet ? 8000 : 6000;
     if (role === "fast") return isOpus ? 10000 : isSonnet ? 8000 : 6000;
     return isOpus ? 6000 : 4000; // vision (figure)
   }
   ```
   Then in each stream route, replace the hard‑coded `maxOutputTokens` literal with `maxOutputTokensFor(slug, role)`. Keep the values inside Anthropic's caps for each model — Haiku 4.5 maxes around 64k context but **8192** completion; Sonnet 4.6 supports 64k completion; Opus 4.7 supports 32k completion. The above values stay well below those ceilings to leave headroom for prompt cache and retries.
2. **Prompt depth toggle.** In the existing prompt builders (`buildSelectionPrompt`, `buildSummaryPrompt`, `buildFigurePrompt`) — `frontend/src/lib/server/prompts/*.ts` — accept an optional `depth: "concise" | "standard" | "deep"` parameter:
   - `concise` → existing prompt + "Be terse and direct. Avoid restating context."
   - `standard` → existing prompt (default).
   - `deep` → existing prompt + "Be thorough. When the answer benefits from depth, include worked steps, edge cases, and cite which paragraph each claim came from."
   Default each route's depth from the chosen model: Haiku → concise, Sonnet → standard, Opus → deep. **Do not** add a UI toggle in this PR — depth is implicit from the model.
3. **Document the new contract** in `frontend/src/lib/server/llm.ts`'s file header so future devs don't yank the per‑model budget.

### Acceptance criteria
- A user on Researcher with Opus selected sees an `Opus` pill on every Summary, Selection, Assumption, Figure, Prepare card; switching to Sonnet then refreshing shows `Sonnet` pills for new artifacts and `Opus` pills for the ones generated under the previous model.
- Pill color uses existing `--highlight-rgb` tints — no new color tokens introduced.
- Opus summaries are visibly longer and more structured than Haiku summaries on the same paper (regression test against any uploaded paper — Opus output should land within 6–10k tokens, Haiku within 2–4k).
- `npm run lint` + `npm run build` pass.

---

## Bug 4 — Font family picker in the analysis pane

### Reported symptom
> "I want to give users the option to change font type (Times New Roman, Calibri, Arial, etc.)"

Today the pane uses Inter for everything (`.analysis-content { font-family: var(--font-inter), system-ui, sans-serif; }`). Power users want serif / system serif / sans choices like the body of the PDF.

### Where to look
- `frontend/src/lib/store.ts` — already has `analysisFontScale` (~L126). Add a sibling `analysisFontFamily`.
- `frontend/src/app/globals.css` `.analysis-content` (~L668) — font‑family declaration.
- `frontend/src/components/panel/BottomPanel.tsx` OverflowMenu body — sits next to the existing Text Size block.

### Required fix
1. **Store slice.** Persisted, like `analysisFontScale`:
   ```ts
   export type AnalysisFontFamily = "sans" | "serif" | "mono" | "times" | "arial";
   analysisFontFamily: AnalysisFontFamily;
   setAnalysisFontFamily: (v: AnalysisFontFamily) => void;
   ```
   Default to `"sans"`. Add to the `persist` partialize allowlist alongside `analysisFontScale`. Resetting in `clearSession` / `setPaper` is **not** wanted — the choice is user‑level, not paper‑level.
2. **CSS hook.** Add a new CSS custom property and switch on it:
   ```css
   :root {
     --analysis-font-family: var(--font-inter), system-ui, -apple-system, "Segoe UI", sans-serif;
   }
   .analysis-content {
     font-family: var(--analysis-font-family);
     /* keep size + line-height as today */
   }
   ```
   The pane wrapper sets `--analysis-font-family` inline based on `analysisFontFamily`, the same way it sets `--analysis-font-scale` today. Map values:
   ```ts
   const FAMILY_TO_VAR: Record<AnalysisFontFamily, string> = {
     sans:  "var(--font-inter), system-ui, -apple-system, sans-serif",
     serif: "var(--font-source-serif), Georgia, 'Times New Roman', serif",
     mono:  "var(--font-jetbrains-mono), ui-monospace, Menlo, Consolas, monospace",
     times: "'Times New Roman', Times, Georgia, serif",
     arial: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
   };
   ```
   **Do not** ship Calibri — it's a Microsoft proprietary font that won't render on macOS / Linux. If users want a Calibri‑like look they pick `arial` (close visual). Add a tooltip noting this if a designer pushes back.
3. **OverflowMenu UI.** Add a "Font family" section beneath "Text size", above "Pane position". Five buttons in a single horizontal row (icon‑less, label only), styled like the existing zoom row:
   ```tsx
   <div className="px-2 pt-1 pb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">
     Font family
   </div>
   <div className="grid grid-cols-2 gap-1 px-1 pb-2">
     {[
       { id: "sans",  label: "Sans"  },
       { id: "serif", label: "Serif" },
       { id: "times", label: "Times" },
       { id: "arial", label: "Arial" },
       { id: "mono",  label: "Mono"  },
     ].map((f) => (
       <button
         key={f.id}
         type="button"
         onClick={() => setAnalysisFontFamily(f.id as AnalysisFontFamily)}
         className={cn(
           "h-7 inline-flex items-center justify-center rounded-md border text-[var(--text-xs)] font-medium",
           analysisFontFamily === f.id
             ? "border-foreground/35 bg-accent/50 text-foreground"
             : "border-border bg-transparent text-foreground/80 hover:bg-accent/40",
         )}
         style={{ fontFamily: FAMILY_TO_VAR[f.id as AnalysisFontFamily] }}
         aria-pressed={analysisFontFamily === f.id}
       >
         {f.label}
       </button>
     ))}
   </div>
   ```
   The button itself uses the target font‑family so users see the typeface in the picker without applying it first (small UX win, no new tokens). Use `cn` from `@/lib/utils`.
4. **Wrapper props.** In `AnalysisPanel` (`BottomPanel.tsx`) where `--analysis-font-scale` is applied, add `--analysis-font-family`:
   ```tsx
   style={{
     ["--analysis-font-scale" as string]: analysisFontScale,
     ["--analysis-font-family" as string]: FAMILY_TO_VAR[analysisFontFamily],
   }}
   ```
5. **Notes path is excluded.** `NotesPanel` uses the legacy `Md` component for the polish path and renders inside `.analysis-content`, so it picks up the new font automatically — that's fine. Verify by switching family and confirming the notes preview re‑renders.
6. **Streamdown / KaTeX.** Math via KaTeX uses its own font stack and **must not** inherit `--analysis-font-family`. Add a guard:
   ```css
   .analysis-content .katex,
   .analysis-content .katex *:not(.know-eq-card) {
     font-family: KaTeX_Main, "Times New Roman", serif;
   }
   ```
   KaTeX already ships its own font; this is just defensive against `--analysis-font-family` leaking into math glyphs.

### Acceptance criteria
- OverflowMenu shows a 5‑button "Font family" picker. Active state matches the rest of the menu's chrome — no new tokens.
- Picking Serif / Times / Arial / Mono changes every panel's prose, headings, lists, blockquotes, tables. Math stays in KaTeX_Main.
- Choice persists across reload (zustand persist).
- No layout shift between fonts — the font scale `--analysis-font-scale` continues to drive size.
- Lint + build pass.

---

## Bug 5 — Analysis‑pane information design: tighten how each card communicates

### Reported request
> "Better design of UI of information of how it is displayed in the analysis pane."

That's vague. Concrete things to do, in order of impact:

### Where to look
- `frontend/src/components/sidebar/SummaryPanel.tsx` — currently renders a stack of `<AnalysisSection>` blocks with prose. No quick‑skim header, no metadata strip, no expand/collapse beyond the legacy accordion rows.
- `frontend/src/components/sidebar/QAPanel.tsx` — Q&A row body is fine, but the row header is a question + chevron with no answer model or "answered in N seconds" metadata.
- `frontend/src/components/sidebar/AssumptionsPanel.tsx` — list of bordered rows, no per‑row tone (explicit vs implicit handled by Badge, but no surface‑level grouping).
- `frontend/src/components/sidebar/FiguresPanel.tsx` — figure detail card mixes thumbnail + question input + chat with no visual separator.
- `frontend/src/components/sidebar/PreReadingPanel.tsx` — Prepare cards. Each card has a title, body, but no scannable header.
- `frontend/src/components/sidebar/RelatedWorkPanel.tsx` — list of items, again no scannable grouping.
- `frontend/src/components/panel/SelectionResultPanel.tsx::ResultCard` — already partially polished after the last batch. Now needs the metadata strip (model + age).

### Required fix — universal across every panel

1. **Add a `CardMeta` primitive.** `frontend/src/components/analysis/CardMeta.tsx`:
   ```tsx
   export function CardMeta({
     model,
     createdAt,
     extra,
   }: {
     model?: string | null;
     createdAt?: number | string | null;
     extra?: ReactNode;
   }) {
     const relative = createdAt ? relativeTime(createdAt) : null;
     return (
       <div className="flex items-center gap-2 text-[var(--text-xs)] text-muted-foreground/85">
         <ModelPill slug={model ?? undefined} />
         {relative && <span title={typeof createdAt === "number" ? new Date(createdAt).toLocaleString() : String(createdAt)}>{relative}</span>}
         {extra}
       </div>
     );
   }
   ```
   `relativeTime` lives in `frontend/src/lib/time.ts` if it exists; otherwise add a 30‑line implementation that returns `"just now"` / `"5m"` / `"2h"` / `"yesterday"` / `"3d"` / dated `MMM d`. **Do not pull in `date-fns`** — we don't need it for one helper.
2. **Slot `CardMeta` into every card header.** The slot goes in the existing `<SectionHeader>` `action` prop, or — for cards that don't use `SectionHeader` directly — as the right‑hand side of the header row.
3. **Compact "key takeaway" header for Summary panel.** The current Summary panel renders Overview first, then Contributions, etc. Add a two‑line "Key takeaway" pulled from the LLM (it already produces `tl_dr` or `overview` — use that, truncated to ~180 chars + ellipsis). Render at the very top, above Overview, in a quiet card:
   ```tsx
   <div className="rounded-[var(--radius-lg)] border border-border/50 bg-card/35 px-4 py-3 dark:bg-card/22">
     <p className="text-[var(--text-xs)] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">Key takeaway</p>
     <p className="mt-1 text-[var(--text-sm)] leading-relaxed text-foreground/90">{takeaway}</p>
   </div>
   ```
   Reuse existing card tokens. If the LLM didn't produce a takeaway, omit the card.
4. **"Show full answer" affordance on long bodies.** For any rendered prose block exceeding ~600 characters, wrap in an `AnalysisAccordionRow` collapsed by default with a `Read more` chevron — the existing primitive already handles open/close + transition. Keeps initial scan height under control. **Do not** add this to streaming bodies (`result.streaming === true`), because collapsing while content is still arriving feels broken.
5. **Group Assumptions by type.** Today the list is mixed. Sort/group with two sub‑headers ("Explicit" then "Implicit"), each an `AnalysisSection title=... eyebrow size="nested">`. If a group is empty, skip its header.
6. **Q&A row header sub‑line.** Below the question text, render a small meta strip with `CardMeta` (model + timestamp). Same row as the chevron.
7. **Figures detail card.** Split into three regions stacked with `space-y-3`:
   1. Image preview (existing).
   2. `CardMeta` strip (model + timestamp + figure number if available).
   3. Chat transcript + question input (existing).
   Today they all blend into one block.
8. **Prepare panel.** Each `PreReading.section` already maps to a card. Add `CardMeta` strip at the bottom of each card, anchored right.
9. **Related Work panel.** Each related item gets `CardMeta` if we know the source ("From abstract", "From references"). If we don't have metadata, omit — never render a half‑empty strip.

### Required fix — typographic polish (lower priority but in this PR)

- `.analysis-content` body line‑height already 1.62. Keep.
- Increase `<h2>` / `<h3>` margin‑top inside `.analysis-content` by **2px** to give scannable air between sections. Confirm no math layout regressions.
- For the new `Key takeaway` card and `CardMeta` strip, no new colors — only `text-muted-foreground/85`, `text-foreground/90`, `bg-card/35`, `bg-muted/30`, `border-border/50`.
- Empty states (any panel with no data) stay as today — don't redesign those in this pass.

### Acceptance criteria
- Every analysis card has a visible model badge + relative timestamp.
- Summary leads with a 2‑line takeaway when one is available; otherwise no card.
- Long prose bodies (>600 chars) collapse into an accordion with `Read more`; streaming bodies never collapse.
- Assumptions list is grouped Explicit → Implicit with quiet eyebrow sub‑headers.
- No new colors, motion tokens, shadows, or radii. Audit your diff against `.cursor/rules/analysis-pane.mdc`.
- `npm run lint` and `npm run build` pass.

---

## Bug 6 — React error #185 crash banner ("Maximum update depth exceeded")

### Reported symptom
The reader sometimes blows up with:
```
Something went wrong
Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.
Try again
```
[react.dev/errors/185](https://react.dev/errors/185) decodes that as **"Maximum update depth exceeded."** React aborted because some component is in an infinite setState/effect loop.

### Diagnosis protocol — do this first

> **Do not guess.** Reproduce, then patch. The investigation is half the bug.

1. **Reproduce in dev mode**, where React prints the full stack:
   ```bash
   cd frontend && npm run dev
   ```
   Open the offending paper, exercise the suspected surfaces (scanned PDF, figure analyze, selection follow‑up, switching panes). The dev build prints the offending component + stack.
2. **Add a temporary render counter** to the suspected components (`PdfViewer`, `FiguresPanel`, `AnalysisPanel`, the new `ModelPill`/`CardMeta` consumers from Bug 5):
   ```ts
   const renderCount = useRef(0);
   renderCount.current += 1;
   if (renderCount.current > 200) console.warn("[render-loop]", "ComponentName", renderCount.current);
   ```
   Whichever component blows past ~200 in a few seconds is the loop site. Remove the counters before committing.
3. **Check zustand selectors that build a new reference every call**. Common antipattern in this codebase:
   ```ts
   const list = useStore((s) => (paperId ? s.pdfRegionHighlightsByPaper[paperId] ?? [] : []));
   ```
   The `?? []` returns a **fresh empty array** every render, which fails the default `Object.is` equality check, which makes every unrelated store update (usage refresh, selection stream chunk, summary stream chunk, font‑scale change…) trigger a re‑render of this component. Combine that with an effect whose dep array contains `list`, and you can rapid‑fire effects that mutate the DOM, which trigger a MutationObserver, which schedules another redraw — the classic explosion.
4. **Diff against `main`**. The error did not happen before commit `c419ab7` (region highlight + figure 404 fix) — bisect the new code paths:
   - `frontend/src/components/pdf/PdfViewer.tsx` — `pdfRegionHighlights` selector, `drawRegionHighlightsForPage`, `handleTextLayerRendered` adjustments, the dep array changes on the MutationObserver effect.
   - `frontend/src/lib/store.ts` — `pdfRegionHighlightsByPaper`, `pendingFigureCaption`, `setPdfTextLayerEmpty`.
   - `frontend/src/components/sidebar/FiguresPanel.tsx` — `AuthImage` cache + retry, the new `useEffect` deps that added `pendingFigureCaption` / `setPendingFigureCaption`.

### Most likely culprit (verify first)

**`PdfViewer` region‑highlight selector creates a fresh array on every render.**

```ts
// PdfViewer.tsx — current
const pdfRegionHighlights = useStore(
  (s) => (paperId ? s.pdfRegionHighlightsByPaper[paperId] ?? [] : []),
);
```

Every store update produces a new `[]` if the paper has no regions, defeating the equality check. The MutationObserver effect declares `pdfRegionHighlights` in its deps, so it tears down + rebuilds the page observers on every store tick. Inside `drainPending`, `drawUnderlinesForPage` + `drawRegionHighlightsForPage` both run, each appending overlay DOM nodes. Even with the `.know-selection-overlay, .know-region-overlay` MutationObserver ignore list, the rebuild cycle still fires `schedulePage(pageEl)` once per arm, and on slow devices that's enough to trip React's update‑depth ceiling.

### Required fix

1. **Stabilize the selector** using zustand's `useShallow` (already a transitive dep) so a fresh empty array doesn't re‑subscribe everywhere:
   ```ts
   import { useShallow } from "zustand/react/shallow";
   // ...
   const pdfRegionHighlights = useStore(
     useShallow((s) => (paperId ? s.pdfRegionHighlightsByPaper[paperId] ?? EMPTY_REGIONS : EMPTY_REGIONS)),
   );
   ```
   Define a module‑level `const EMPTY_REGIONS: PdfRegionHighlight[] = []` so the fallback is always the same identity. (zustand's `useShallow` does element‑wise comparison, but an empty array passes the shallow check anyway because both sides have length 0.)
2. **Drop `pdfRegionHighlights` from the MutationObserver effect's dep array.** That effect only needs to *react* to mounts/unmounts of `.react-pdf__Page` and text‑layer mutations — it shouldn't re‑arm observers when the region list churns. Move the region draw out to a dedicated, narrower effect:
   ```ts
   useEffect(() => {
     const container = containerRef.current;
     if (!container) return;
     container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]").forEach((el) => {
       const num = parseInt(el.getAttribute("data-page-number") || "0", 10);
       if (num > 0) drawRegionHighlightsForPage(el, num, pdfRegionHighlights);
     });
   }, [pdfRegionHighlights, drawRegionHighlightsForPage]);
   ```
   This effect *only* re‑runs when regions change, paints once, and exits. It does not touch the MutationObserver lifecycle.
3. **Confirm `drawRegionHighlightsForPage` is referentially stable.** It already is (`useCallback(..., [])`). If you find yourself adding state deps to it, you've reintroduced the loop — push the state into a ref instead.
4. **Audit other "fresh array" selectors in the codebase** while you're here:
   ```bash
   rg -n "useStore\(\(s\) =>.*\?\? \[\]" frontend/src
   ```
   Wrap each hit in `useShallow` or point at a stable `EMPTY_*` constant. Targets to verify (do not blanket‑edit — apply the same `useShallow` pattern only if there's evidence of churn):
   - `pdfRegionHighlights` (this bug, fix it).
   - Any new selector added in Bug 3 / Bug 5 returning `array ?? []` — anticipate and pre‑empt.
5. **`figureBlobCache` retain set must be referentially stable too.** In `AuthImage`'s cleanup effect:
   ```ts
   useEffect(() => {
     return () => {
       if (blobUrl && !Array.from(figureBlobCache.values()).includes(blobUrl)) {
         URL.revokeObjectURL(blobUrl);
       }
     };
   }, [blobUrl]);
   ```
   `Array.from(...).includes(...)` is O(n) and allocates each call, but the effect only runs on `blobUrl` change so it's not a loop trigger today. Keep it — only flag if the audit shows it. If you do refactor: invert to a `Set<string>` mirror that gets updated alongside the LRU `Map`, so cleanup is O(1) and doesn't allocate.

### Things to **not** do

- Do **not** wrap render bodies in `try/catch`. The error boundary already exists; the fix is at the root cause.
- Do **not** memoize derived values with `useMemo` to paper over the loop. If the loop is real, `useMemo` only masks it until the next dep churn.
- Do **not** suppress the error overlay with `if (process.env.NODE_ENV === "production")` guards. The user has to see the crash banner — that's the existing behavior.

### Acceptance criteria

- Scanned PDF: marquee a region, switch tabs, switch papers, switch back. No crash banner, no console warnings about update depth.
- Heavy session: open paper, run Summary, run a Selection, paste a figure, ask a Q&A — no banner.
- React DevTools profiler shows `<PdfViewer>` rendering ≤ once per real state change (not on every store tick).
- Dev mode console clean of "Maximum update depth" warnings.

---

## Cross‑bug invariants

- **No new dependencies.** All work ships from existing packages.
- **Never reintroduce removed primitives** (`LocalModelProvider`, `Ollama`, qwen, `KNOW_LOCAL_MODEL_*`). The architecture rule still applies.
- **Python side stays untouched.** Slugs already come from `/api/internal/user/{id}/models`; do not duplicate `gating.py` in TS, and do not edit any `backend/**/*.py` for this batch.
- **Stream routes only set the model header — they don't validate model output length.** Anthropic returns whatever it returns; the per‑model `maxOutputTokens` from Bug 3C is the soft ceiling.
- **No `console.log` survives in production code.** Diagnostic logs you add while investigating must be removed before the PR.
- **Type safety**: every PR file must pass `tsc` without `any` casts. Widen via Zod first, then propagate.

---

## Suggested execution order

1. **Bug 6** (render loop) — investigate and fix first. A crashed reader makes the rest of this work impossible to QA.
2. **Bug 2** (delete gear) — 5 minutes, mechanical.
3. **Bug 1** (OverflowMenu fix) — small primitive change, unblocks Bug 4.
4. **Bug 4** (font family picker) — small store + CSS + menu addition.
5. **Bug 3** (model badges + per‑model output budget) — biggest plumbing change. Land before Bug 5 so Bug 5 can render the `ModelPill` without TODOs.
6. **Bug 5** (information design) — last so the new `ModelPill` / `CardMeta` are ready to drop in.

After all five land:

- Upload a paper → run Summary on Opus → see `Opus` pill on the resulting card, body visibly longer than the same paper on Haiku.
- Open OverflowMenu → cycle font families → confirm every panel reflows.
- Reader navbar has no standalone gear.
- Keyboard‑activate the menu (Tab + Enter) — works.
- `npm run lint`, `npm run build`, and a manual click through Summary / Prepare / Assumptions / Q&A / Figures / Selection / Related / Notes.

---

## File map (touch only these — anything else is out of scope)

- [ ] `frontend/src/components/analysis/OverflowMenu.tsx`
- [ ] `frontend/src/components/analysis/ModelPill.tsx` *(new)*
- [ ] `frontend/src/components/analysis/CardMeta.tsx` *(new)*
- [ ] `frontend/src/lib/modelLabels.ts` *(new)*
- [ ] `frontend/src/lib/time.ts` *(new if doesn't already exist)*
- [ ] `frontend/src/components/panel/BottomPanel.tsx`
- [ ] `frontend/src/components/panel/SelectionResultPanel.tsx`
- [ ] `frontend/src/components/panel/SectionHeader.tsx` *(only if the meta slot needs adjusting — likely no)*
- [ ] `frontend/src/components/sidebar/SummaryPanel.tsx`
- [ ] `frontend/src/components/sidebar/AssumptionsPanel.tsx`
- [ ] `frontend/src/components/sidebar/QAPanel.tsx`
- [ ] `frontend/src/components/sidebar/FiguresPanel.tsx`
- [ ] `frontend/src/components/sidebar/PreReadingPanel.tsx`
- [ ] `frontend/src/components/sidebar/RelatedWorkPanel.tsx`
- [ ] `frontend/src/components/sidebar/NotesPanel.tsx` *(only the analysis‑content body — leave the polish path alone)*
- [ ] `frontend/src/lib/store.ts` *(font family slice)*
- [ ] `frontend/src/app/globals.css` *(`--analysis-font-family` plumbing only)*
- [ ] `frontend/src/lib/api.ts` *(types: `model?` on the three result shapes)*
- [ ] `frontend/src/lib/server/schemas.ts` *(`model: z.string().optional()`)*
- [ ] `frontend/src/lib/server/llm.ts` *(`maxOutputTokensFor`)*
- [ ] `frontend/src/lib/server/prompts/selection.ts`
- [ ] `frontend/src/lib/server/prompts/summary.ts`
- [ ] `frontend/src/lib/server/prompts/figure.ts`
- [ ] `frontend/src/app/api/papers/[id]/summary-stream/route.ts`
- [ ] `frontend/src/app/api/papers/[id]/selection-stream/route.ts`
- [ ] `frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts`
- [ ] `frontend/src/app/paper/[id]/page.tsx` *(remove gear button only)*
- [ ] `frontend/src/components/pdf/PdfViewer.tsx` *(selector stabilization + region draw effect split — Bug 6 only)*

Do **not** open:

- `backend/**/*.py`
- `frontend/src/lib/server/internalApi.ts` (no changes required)
- `frontend/vercel.json`
- Anything under `frontend/src/components/pdf/` or `frontend/src/components/reader/`
- Any of the auth or billing routes

If you think one of those needs to change, **stop and ask**.

---

## Definition of done

- All six bugs green against their acceptance criteria.
- `npm run lint` and `npm run build` both pass.
- Manual smoke pass logged at the bottom of the PR description with screenshots: a clean profiler trace through a heavy session (Bug 6), opened panel menu (Bug 1), reader navbar without gear (Bug 2), `Opus` pill on a Summary card vs `Haiku` pill on a follow‑up (Bug 3), the new font family picker open (Bug 4), and a card showing the new `CardMeta` strip + grouped Assumptions (Bug 5).
- Commit message: `fix(frontend): render loop on scanned PDFs + model badges, font family, info design, menu, navbar` (or similar — focus on the *why*).
- No new `console.log`, no new colors, no new motion durations, no new shadow tokens, no new radii.
