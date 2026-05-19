# Know — bug‑fix briefing #5 for Composer 2.5

> **Scope**: five upgrades to the authenticated reader. Two are UX gaps in the model‑transparency work PROMPT_3 started (model lag, no follow‑up override), one is a long‑standing settings‑sync miss, one is the analysis‑pane overflow menu being effectively invisible, one is the bibliography splitter producing one giant bullet on bib formats with no leading line breaks. Stay inside `.cursor/rules/*.mdc` (analysis‑pane, architecture, latex). **Read those rules first.** Reuse existing primitives — no new color / shadow / motion tokens.
>
> **Stack reminders**: Next.js 16 + AI SDK v6 + Zod 4. The migrated streaming routes (`selection-stream`, `summary-stream`, `figure-qa-stream`) live on Next.js. Batch endpoints (`/api/papers/{id}/assumptions`, `/api/papers/{id}/qa`, `/api/papers/{id}/analyze`, `/api/papers/multi-qa`, `/api/settings`) stay on Python. Tier gating + model resolution are the Python source of truth (`gating.py`, `resolve_*_model`).
>
> **Test plan**: `npm run lint` + `npm run build` after each bug. Smoke each surface in the IDE preview.
>
> **Order**: 4 → 1 → 3 → 5 → 2 (cheapest visible fixes first; backend persistence last).

---

## Snapshot of the offending surfaces

| Concern | Files |
|---|---|
| Model lag + invisibility while streaming, no per‑follow‑up override | `frontend/src/lib/UserSettingsContext.tsx` (new), `frontend/src/lib/useSelectionThread.ts`, `frontend/src/lib/useSummaryStream.ts`, `frontend/src/components/sidebar/SummaryPanel.tsx`, `frontend/src/components/panel/SelectionResultPanel.tsx`, `frontend/src/components/sidebar/FiguresPanel.tsx`, `frontend/src/components/analysis/ModelPill.tsx`, `frontend/src/app/api/papers/[id]/selection-stream/route.ts`, `frontend/src/app/api/papers/[id]/summary-stream/route.ts`, `frontend/src/app/api/papers/[id]/figure-qa-stream/route.ts` |
| Background preset stored per browser, not per user | `frontend/src/lib/backgroundImage.ts`, `frontend/src/components/AppearanceSection.tsx`, `frontend/src/lib/api.ts`, `backend/app/api/settings.py`, `backend/supabase/migrations/*` |
| Assumptions not auto‑extracting on first paper open | `frontend/src/app/paper/[id]/page.tsx`, `frontend/src/components/sidebar/AssumptionsPanel.tsx`, `frontend/src/components/panel/BottomPanel.tsx` |
| Analysis‑pane settings menu effectively invisible | `frontend/src/components/panel/BottomPanel.tsx`, `frontend/src/components/analysis/OverflowMenu.tsx`, `frontend/src/app/globals.css` |
| Related works: entire bibliography rendered as one bullet | `backend/app/services/citation_resolve.py` (`split_bibliography_chunks`), `frontend/src/lib/formatBibliography.ts`, `frontend/src/components/sidebar/RelatedWorkPanel.tsx` |

If a fix touches code from PROMPT_3/4 (overflow menu trigger contract, region effect split, ensureDisplayMath / firstSentence, LRU papersById, stable observer scope), **do not revert** the architectural decisions. Build on top.

---

## Bug 1 — Make the model obvious during loading, eliminate the badge lag, add a per‑follow‑up override

### Reported symptom
> "For selection it's good now but not for analysis pane show while AI is loading as well. Please show the model being used faster — right now there is a lag for both selection and analysis pane. Maybe also give users options to change the model for follow‑up questions?"

Three problems:

1. **Lag.** Today both `useSelectionThread.start` and `useSummaryStream.start` call `api.getSettings()` **after** `obj.submit({})` fires (`useSelectionThread.ts` ~L175; `useSummaryStream.ts` ~L205). The settings fetch is a separate Python round‑trip (~150–500 ms), so the pill only appears once the response lands — long after the stream has been writing prose for half a second.
2. **No badge while streaming.** Cards render `<CardMeta model={s.model} createdAt={s.created_at} />`, but the streaming partial doesn't carry `model` until the settings fetch resolves. So Summary / Selection show no pill at all during the visible loading state.
3. **No per‑follow‑up override.** The follow‑up composer (`BottomPanel.handleFollowUp` → `useSelectionThread.start({action: "followup"})`) always uses the fast model from Settings. Users want to upgrade a single follow‑up to Opus without flipping the global default.

### Root cause
- Settings are fetched per‑stream, not cached app‑wide.
- The model header (`X-Know-Model`) lands when the response starts; but `experimental_useObject` doesn't expose response headers on a `fetch` we can read. So we'd need a custom fetcher OR — much simpler — already know the model client‑side at submit time.
- The stream routes don't accept a per‑request model override yet.

### Required fix

#### 1a. App‑wide settings context that prefetches on mount
1. **New file `frontend/src/lib/UserSettingsContext.tsx`.** Standard React context + provider that fetches `api.getSettings()` once when the signed‑in user mounts the reader, exposes `{ analysisModel, fastModel, allowedModels, refresh, updateOptimistically }`. Cache in `useRef`; revalidate on tier change.
   ```tsx
   export type UserSettings = {
     analysisModel: string;
     fastModel: string;
     hasAnthropicKey: boolean;
     loaded: boolean;
   };
   ```
   Wire into `frontend/src/app/paper/[id]/page.tsx` and `frontend/src/app/dashboard/page.tsx` shells (whichever already wraps Clerk auth + UserTierProvider). Default to `{ analysisModel: "claude-sonnet-4-6", fastModel: "claude-haiku-4-5", loaded: false }` so the pill always renders something readable while the fetch resolves.
2. **Refactor selection + summary streams** to read the model synchronously from the new context **before** `obj.submit`:
   - In `useSelectionThread.start`, drop the `void api.getSettings().then(...)` block. Take `fastModel` from the context (the hook caller passes it in, or the hook calls `useUserSettings()` directly).
   - Same in `useSummaryStream.start`: take `analysisModel` from context, set `streamModelRef.current = analysisModel` synchronously before `obj.submit({})`.
   - `FiguresPanel.handleAnalyze` already reads `X-Know-Model` from `res.headers` — keep that, but also set a provisional `streamModel = fastModel` from context so the in‑flight assistant bubble can show the pill before the response header lands.
3. **Render a pill while streaming.** In each panel where streaming meta is shown, render `<CardMeta>` with the provisional model the moment the request starts:
   - `SummaryPanel.tsx`: when `stillStreaming && !s.model`, fall back to `userSettings.analysisModel`. Add a `model={s.model ?? userSettings.analysisModel}` pattern.
   - `SelectionResultPanel.tsx` (`ResultCard`): when `isStreaming && !result.model`, fall back to `userSettings.fastModel`.
   - `FiguresPanel.tsx` detail view: same fallback to `userSettings.fastModel`.
   - **Important**: the fallback must visually mark the pill as "pending confirmation" — append a small dot or muted state so users know we're showing the *expected* model, not the *confirmed* one. Reuse the existing streaming‑cursor blink class:
     ```tsx
     <ModelPill slug={resolvedModel} pending={isStreaming && !result.model} />
     ```
     Update `ModelPill` to accept `pending`. When `pending`, render the pill at 75% opacity (using existing `text-foreground/70` token) with the existing pulse class (`motion-safe:animate-pulse` already on `StreamingMarkdown`'s cursor). **No new tokens.**
4. **Selection model already lands from a header** in `FiguresPanel.tsx`. For Summary and Selection, the actual model is whatever the server resolved (Python `resolve_analysis_model` / `resolve_fast_model`). The provisional fallback may be wrong if Python applied tier caps — that's fine, the streaming label updates to the real slug once `onFinish` sets `s.model` on the cached result. Keep the same flow.

#### 1b. Per‑follow‑up model override
Users want a small dropdown on the follow‑up composer that lets them upgrade *this* question to a heavier model without touching the global Settings.

1. **API change — stream routes accept an optional `model` body field.**
   - `selection-stream/route.ts`: parse `body.model` (optional string). If present, validate against `gating.get_allowed_models(userId)` (call a small new endpoint `/api/internal/user/{id}/allowed-models` that proxies `get_allowed_models`), else fall back to the resolved fast model. **Constant‑time** compare against the allowed list — never trust raw client input.
   - Same for `summary-stream/route.ts` (for the followup case if we ever stream summaries on demand — keep API symmetric).
   - `figure-qa-stream/route.ts`: same.
   - `X-Know-Model` response header should reflect whatever model actually ran (override or default), so the client confirms.
2. **Server validation helper.** In `frontend/src/lib/server/internalApi.ts`, add a thin wrapper:
   ```ts
   export async function fetchAllowedModels(userId: string, signal?: AbortSignal): Promise<string[]>;
   ```
   In each route, after parsing `body.model`, validate via:
   ```ts
   const wanted = body.model?.toString().trim();
   const allowed = wanted ? await fetchAllowedModels(user.userId) : null;
   const requestedModel = wanted && allowed?.includes(wanted) ? wanted : null;
   const fastModel = requestedModel ?? prefs.fast_model;
   ```
   On invalid `model`, **do not 400** — fall back to the user's default silently. Users may have downgraded their plan between request prep and submit.
3. **Python side**: add `GET /api/internal/user/{id}/allowed-models` that returns `{ allowed: list[str] }` from `get_allowed_models`. Reuse the existing HMAC bearer in `auth.py`. No tier / model changes.
4. **Client UI — model picker on follow‑up composer.**
   - In `BottomPanel.tsx` follow‑up input row (the one that calls `handleFollowUp`), add a small inline `OverflowMenu` trigger to the *left* of the submit button, sized like a chip:
     ```tsx
     <ModelOverridePill
       model={overrideModel ?? userSettings.fastModel}
       allowed={userSettings.allowedModels}
       onChange={setOverrideModel}
     />
     ```
   - `ModelOverridePill.tsx` (new file under `frontend/src/components/analysis/`): renders a `<ModelPill>` button that opens an `OverflowMenu` listing each allowed model with its tone color. Selection writes to local state; the value gets passed into `handleFollowUp` and from there into `selectionThread.start({ action: "followup", selectedText, question, model: overrideModel })`.
   - `useSelectionThread.start` accepts `model?: string`, passes it through `obj.submit({ ..., model })`.
5. **State shape**: the override is *per follow‑up*, not sticky. Reset to `null` after each send (so the next follow‑up defaults back to the user's Settings choice). This matches the user request ("for follow‑up questions") — they don't want a session‑wide override that quietly raises their bill.
6. **Gating gotcha**: the existing `enforce_model` on Python side already caps requests by tier and writes a fallback to user prefs if the user's stored choice exceeded tier. For the per‑request override we should **not** persist anything — just route this one call. Add a comment in `internalApi.ts` saying "override is single‑shot; never propagate to /api/settings."

### Acceptance criteria
- The model pill appears in the Summary header within ~50 ms of clicking "Generate Summary" (no Python round‑trip in the critical path).
- The model pill appears in the Selection card the moment the user clicks Explain / Derive / Submit follow‑up.
- During streaming, the pill is visually marked as pending (opacity / pulse), and updates to the confirmed model on `onFinish`.
- The follow‑up composer has a small model chip that opens a menu of allowed models. Selecting "Opus" upgrades only that follow‑up; the next one falls back to the user's Settings default.
- If a user without Opus access manages to submit `model: "claude-opus-4-7"` from the client, the route silently falls back to the resolved fast model — no 400, no Python error.
- The `X-Know-Model` response header on every stream reflects whatever ran (override or default).
- `npm run lint` + `npm run build` pass.

---

## Bug 2 — Background preferences are stored per browser

### Reported symptom
> "Why do background preferences depend on the selected browser?"

User signs in on browser A, picks a background. Signs in on browser B from the same account — back to the default. The choice should follow the account, not the browser.

### Root cause
`frontend/src/lib/backgroundImage.ts`:
```ts
export function loadBackgroundStateForUser(userId: string | null): BackgroundState {
  if (typeof window === "undefined" || !userId) return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(backgroundStorageKey(userId));
    ...
```

`backgroundStorageKey` namespaces by `userId`, but everything still lives in `localStorage`. Cross‑device sync requires server‑side persistence.

### Required fix
Server‑side: extend `/api/settings` to carry background prefs. Client: read on mount, write through.

1. **Database.** Add a `background_preset` and `background_opacity` column to `users` (or a `user_preferences` row — pick whichever pattern `analysis_model` / `fast_model` already use; they live on `users` per `backend/supabase/migrations/003`). New Supabase migration `backend/supabase/migrations/0NN_user_appearance.sql`:
   ```sql
   ALTER TABLE users
     ADD COLUMN IF NOT EXISTS background_preset TEXT,
     ADD COLUMN IF NOT EXISTS background_opacity REAL;
   ```
   Don't backfill — null means "use default + whatever was last in localStorage" (one‑way migration on next save).
2. **Backend `/api/settings`.**
   - Extend the `Settings` response model (`backend/app/models/schemas.py` or wherever `SettingsResponse` is defined) with optional `background_preset?: string` and `background_opacity?: number`. Don't break older clients.
   - Update `PUT /api/settings` to accept the same two optional fields. Validate `background_preset` against the known preset IDs (`BACKGROUND_PRESETS` lives in `frontend/src/lib/backgroundImage.ts` — mirror the id set server‑side in `backend/app/services/appearance.py` or just hard‑code a small allow‑list there). `background_opacity` must clamp to `[0, 1]`.
   - Use `_save_user_model_prefs`'s row‑update pattern; do not write through Clerk metadata (we already do model prefs on the Supabase row).
3. **Frontend types.** Add `background_preset?: string` and `background_opacity?: number` to `SettingsResponse` and the `updateSettings` arg in `frontend/src/lib/api.ts`.
4. **Frontend wiring.**
   - `AppearanceSection.tsx`: on mount, hydrate from `api.getSettings()` (use the new UserSettingsContext from Bug 1 — one fetch covers both bugs). Fall back to `loadBackgroundStateForUser(userId)` for stale localStorage so users don't lose their pick before they're online.
   - On change, call `api.updateSettings({ background_preset, background_opacity })` and **also** write to localStorage as a local cache for offline / first‑paint perf.
   - In `backgroundImage.ts`, leave the localStorage helpers in place but rename them to make the cache layer obvious:
     ```ts
     // @deprecated Server is the source of truth; localStorage is a cache only.
     export function readBackgroundCache(userId: string | null): BackgroundState;
     export function writeBackgroundCache(state: BackgroundState, userId: string): void;
     ```
5. **First paint.** The settings hydration happens client‑side and may flash the default background. Mitigate by reading `localStorage` first (sync, no flash), then reconciling with the server response. Already done by the cache‑then‑refresh pattern above.
6. **Logout cleanup.** Already handled in `ThemeProvider` style — clear the localStorage entry on `signOut` so the next signed‑in user doesn't briefly see the previous account's background.

### Acceptance criteria
- Signing in on a second browser shows the same background preset within one network round‑trip of the dashboard mount.
- Changing the preset writes to `/api/settings`; refreshing the page shows the new value without depending on localStorage.
- Logging out then logging in as a different account shows the new account's preset (not the previous one).
- Server validates the preset id against the allow‑list; a stale or invalid value falls back to the default without throwing.
- `npm run lint` + `npm run build` pass.

---

## Bug 3 — Assumptions tab doesn't load on first paper open

### Reported symptom
> "Assumptions tab still not loading after first opening a paper unless I switch to it."

User opens a paper. Summary, Prepare auto‑extract. Assumptions don't — the user clicks the Assumptions tab and sees an empty state with the "Extract Assumptions" button.

### Root cause
The auto‑extract effect in `paper/[id]/page.tsx` (~L966) gates on three checks:
1. `useStore.getState().assumptions.length === 0` (true on first open)
2. `!hasActiveRequest(pid, "assumptions")`
3. `!autoAnalyzedPapers.has(\`${pid}:assumptions\`)`

The deps array is `[loadedPaperId, activePaperId, tierLoading, ...]`. On first paint, `tierLoading` is `true` briefly (Clerk + UserTier hydration), so the effect early‑returns. Then `tierLoading` flips to `false`, the effect runs once, fires `api.getAssumptions(pid)`. **But** the panel isn't mounted yet (only `summary` + `preread` are pre‑mounted in `BottomPanel.tsx` L90–L93). So when the response lands, `setAssumptions(...)` writes to the store but no UI reflects the loading state. When the user finally clicks Assumptions, the result is already there and the panel renders it — but only if the auto‑extract succeeded. If it failed (cooling down, network blip), the user sees the empty state and has to click "Extract" manually.

There's also a subtler race: `hasUsableAssumptions` checks `serverAssumptions && serverAssumptions.length > 0`. If the cache row exists but contains `assumptions: []` (Python's "no usable assumptions found" sentinel), `hasUsableAssumptions` is false **and** the effect still kicks off another fetch — wasting an LLM call and worsening the perceived lag.

### Required fix

1. **Pre‑mount Assumptions tab.** In `BottomPanel.tsx` L90–L93, add `"assume"` to the initial `mountedTabs` set alongside `summary` and `preread`. This costs ~3 KB of JSX hydration but it's the simplest way to ensure the loading shimmer is visible from first paint.
   ```ts
   const [mountedTabs, setMountedTabs] = useState<Set<string>>(() => {
     const next = new Set<string>([effectiveTab]);
     next.add("summary");
     next.add("preread");
     next.add("assume");
     return next;
   });
   ```
2. **Lazy retrigger on tab activation.** Even with pre‑mount, the panel should be defensive. In `AssumptionsPanel.tsx`, add an effect that retriggers `handleExtract` on mount when:
   - `assumptions.length === 0`
   - `!coolingDown`
   - `!assumptionsLoading` (don't double‑fire)
   - `!hasActiveRequest(paperId, "assumptions")`
   - `!autoAnalyzedPapers.has(\`${paperId}:assumptions\`)` (the same guard the page uses, so we don't double‑extract on mount + page effect)
   - tier allows it
   ```tsx
   useEffect(() => {
     const pid = paperId;
     const cooldown = (paper?.id === pid ? paper.cached_analysis?.assumptions_cooldown_until || 0 : 0) > Date.now() / 1000;
     if (
       assumptions.length === 0 &&
       !cooldown &&
       !assumptionsLoading &&
       !hasActiveRequest(pid, "assumptions") &&
       !autoAnalyzedPapers.has(`${pid}:assumptions`)
     ) {
       void handleExtract();
     }
     // We only want this on mount per paper — the page-level effect handles
     // first auto-extract, this is the safety net for the case the page
     // effect early-returned (tierLoading) and the user navigated tabs
     // before it ran.
     // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [paperId]);
   ```
   Import `hasActiveRequest` from `@/lib/analysisState` and `autoAnalyzedPapers` from the same module.
3. **Stop double‑fetching when the cache says "tried and got nothing".** In `paper/[id]/page.tsx` auto‑extract gate, replace `hasUsableAssumptions = !!(serverAssumptions.length > 0 || ...)` with:
   ```ts
   const cacheHasAssumptionsKey = cache.assumptions !== undefined; // backend wrote a row
   const cacheNonEmpty = (cache.assumptions?.assumptions?.length ?? 0) > 0;
   const hasUsableAssumptions = cacheNonEmpty || sessionAssumptions?.length || storeSnap.assumptions.length > 0;
   if (cacheHasAssumptionsKey && !cacheNonEmpty) {
     // Backend tried; respect that and don't re-run.
     autoAnalyzedPapers.add(`${pid}:assumptions`);
   }
   ```
   This stops "the model didn't find any" from re‑triggering an extraction on every page load.
4. **Re‑arm `autoAnalyzedPapers` on hard refresh.** Today the set is module‑level — it survives soft navigations but resets on full page reload. That's the intended behavior. Don't change it.
5. **Cooldown UI.** When `coolingDown` is true the empty state already shows a helpful message. Keep that as the user's signal that the system tried.

### Acceptance criteria
- Opening a paper for the first time auto‑extracts assumptions; the Assumptions tab shows the loading shimmer from first paint and lands on the result without the user clicking the tab.
- If the backend already returned an empty result (cache hit, "no usable assumptions"), the auto‑extract does **not** re‑fire on subsequent opens.
- If the user opens the Assumptions tab and there's no data + no cooldown + no active request + tier allows it, the panel kicks off a one‑shot extract.
- Cooling‑down state surfaces the existing message, no auto‑extract.
- `npm run lint` + `npm run build` pass.

---

## Bug 4 — Analysis‑pane settings dropdown is effectively invisible

### Reported symptom
> "I cannot even see the settings dropdown menu in the analysis pane (the one to change analysis pane position or font)."

User can't find the kebab / sliders icon that opens the font + position menu. PROMPT_3 Bug 1 fixed the click target; this is a visibility / affordance problem layered on top.

### Root cause
In `BottomPanel.tsx`, the OverflowMenu trigger renders a 14 × 14 px "sliders" SVG (`stroke-current`, `text-muted-foreground`) inside the tab strip header (`h-10`, `bg-muted/[0.06]`). Against the muted strip, a 14 px gray icon vanishes — especially on light theme. There's no label and the icon is the EQ‑mixer shape that nobody associates with "settings".

### Required fix
Make the trigger discoverable without adding new tokens.

1. **Bigger icon + label on wide panes.** Bump the icon to `h-4 w-4`, swap the EQ glyph for the standard gear (the same `d` already used elsewhere in the codebase — see Settings link in `paper/[id]/page.tsx` ~L1797). Add a "Display" text label that shows when the side pane is wider than ~260 px:
   ```tsx
   triggerInner={
     <span className="inline-flex items-center gap-1.5">
       <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
         <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
         <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
       </svg>
       <span className="hidden md:inline text-[var(--text-xs)] font-medium">Display</span>
     </span>
   }
   ```
   `md:inline` shows the label only when the panel is at least ~768 px wide (covers bottom‑pane mode). For the side‑pane mode (typically 320–520 px wide) the icon alone reads.
2. **Trigger background.** Today the trigger is `rounded-md p-1 ... hover:bg-accent/60`. Without hover, on a muted strip, the trigger has no fill. Add a subtle resting state using the existing `bg-accent/25` token:
   ```ts
   className: "rounded-md p-1 text-foreground/85 transition-colors hover:bg-accent/60 hover:text-foreground data-[popup-open]:bg-accent/60 motion-safe:duration-150 bg-accent/0 md:px-2 md:py-1",
   ```
   `text-foreground/85` (instead of `text-muted-foreground`) is already used elsewhere in the codebase — no new token.
3. **`shrink-0` on the trigger wrapper.** The OverflowMenu sits next to a `flex-1` tab strip. Add `shrink-0` to the OverflowMenu's button so a wide tab list never visually crowds it out of the row.
4. **Tooltip + accessible name.** Keep the existing `title="Panel options — text size, font, pane position"`. Add `aria-haspopup="menu"` (base‑ui adds this automatically via `Popover.Trigger`; just verify in DevTools).
5. **No new motion / shadow.** Don't add a glow or drop‑shadow ring. The bg + label combination is enough.

### Acceptance criteria
- On the bottom pane (≥ 768 px) the trigger reads "⚙ Display" — instantly recognizable as a settings affordance.
- On the side panes (< 768 px) the gear icon is `h-4 w-4` and contrast is at least 4.5:1 against `bg-muted/[0.06]` in both themes.
- Click / Enter / Space opens the menu; Escape closes (PROMPT_3 Bug 1 behavior preserved).
- No new color / shadow / motion tokens introduced.
- `npm run lint` + `npm run build` pass.

---

## Bug 5 — Related works: entire bibliography becomes one bullet

### Reported symptom
> "Sometimes entire citations appear as one bullet point."

Example (from user paste): under "Classical / pre‑deep‑learning HP model solvers" a single bullet contains a Scholar link whose text is literally a concatenation of *many* references separated by `. ` runs.

### Root cause
`backend/app/services/citation_resolve.py::split_bibliography_chunks` (~L364–L414) regex‑scans for numbered markers at line starts:
```
(?:^|\n)\s*\[\s*(\d{1,4})\s*\]
(?:^|\n)\s*(\d{1,4})\.\s*(?=[A-Za-z\"“„(\[{0-9≤≥])
(?:^|\n)\s*\((\d{1,4})\)\s+(?=[A-Za-z\"“„])
(?:^|\n)\s*(\d{1,4})\)\s+(?=[A-Za-z\"“„(\[{])
```

If a PDF's bibliography text comes out on a single line (collapsed `\n`, common for PDF.js text‑layer output) **none of these match**. Then the catch‑all at L403–L412 returns `{"1": bstrip[:32000]}` — the **whole bibliography** as one chunk → one citation row → one bullet.

`build_prior_work_topics_from_clusters` then groups that one row into the "Classical solvers" cluster (because the model's cluster output references it), and the Related Work panel renders it as a single `<li>` with a Scholar search link whose query is the entire concatenated text.

### Required fix

#### 5a. Loosen the marker regex to allow mid‑line numbers
Many PDFs produce a single line containing `... 2017. K. Yang, H. Huang, ... 2023. ...`. Extend the matcher to also catch the in‑line case while staying safe (don't match every "v2" in a URL).

In `split_bibliography_chunks` add **after** the line‑start patterns, and **before** the chunks dict is built:

```python
# In-line fallback: bibliography pasted as one line. Look for
# "<space><digit>. <Capital letter or quote>" — strict enough to
# avoid matching "vol. 2." or "p. 12.". Only used when no line-start
# markers fired above.
if not markers:
    for m in re.finditer(
        r"(?<=[\s\.\)])(\d{1,4})\.\s+(?=[A-Z\"“„][A-Za-z\.])",
        bib,
    ):
        # Skip false positives inside URLs / DOIs / arXiv IDs.
        ctx = bib[max(0, m.start() - 24): m.start()]
        if re.search(r"(?:doi:|10\.\d{4,9}/|arxiv\.org|arxiv:\s*\d{3,4}\.)\s*$", ctx, re.I):
            continue
        markers.append((m.start(0), str(int(m.group(1)))))

    # Sequence sanity: only accept if the numbers are monotonically
    # increasing (with at most 2 small dips for inline year confusion).
    # A bibliography numbers 1..N — random "2." mid-text isn't a marker.
    if markers:
        nums = [int(n) for _, n in markers]
        good = sum(1 for i in range(1, len(nums)) if nums[i] >= nums[i - 1] - 1)
        if good / max(1, len(nums) - 1) < 0.75:
            markers = []
```

The strict sequence‑sanity guard prevents "Vol. 17. " in an inline blob from being misread as marker `17.` — a real bibliography goes 1, 2, 3, …

#### 5b. Sentence‑split fallback instead of "everything is one chunk"

When markers remain empty, today we return `{"1": bstrip[:32000]}`. That's the bug. Replace the catch‑all with a sentence‑split heuristic:

```python
if not chunks and len(bstrip) >= 80:
    # No structured markers found — split on terminal periods followed by
    # a capitalized author initial pattern. Bibliographies tend to read
    # "Lastname, F.M.," after every period.
    parts = re.split(r"(?<=[.\]])\s+(?=[A-Z][a-z]?[.,]\s+[A-Z])", bstrip)
    parts = [p.strip() for p in parts if len(p.strip()) >= 30]
    if len(parts) >= 2:
        return {str(i + 1): p[:4000] for i, p in enumerate(parts[:120])}
    # If we still can't split, return UP TO 1200 chars as one chunk so we
    # don't shove a 32000-char wall into the UI.
    return {"1": bstrip[:1200]}
```

The new path:
- Tries marker‑based split first (existing).
- Then inline‑marker fallback (5a).
- Then sentence‑split heuristic (5b).
- Only as a last resort returns a single chunk, and trims it to 1200 chars so the UI can't show the giant blob.

#### 5c. Client‑side defense
In `frontend/src/lib/formatBibliography.ts::sanitizeCitationForDisplay`, hard‑cap the displayed length at ~480 chars (already what `title.slice(:480)` does upstream, but `citation_display` is rendered raw). Add:
```ts
if (s.length > 480) s = `${s.slice(0, 480).replace(/\s+\S*$/, "")}…`;
```
This isn't a fix for the underlying bug — it's belt‑and‑braces so the UI never again renders a 32000‑char `<a>` text.

#### 5d. Don't regress the single‑item case
Some papers really do have one short reference (commentaries, opinion pieces). The new sentence‑split heuristic requires `len(parts) >= 2` before splitting — single‑reference papers fall through to the 1200‑char single chunk, same as today.

### Acceptance criteria
- Re‑running Prepare on the test paper (HP‑model deep‑RL paper from the user report) produces N distinct bullets, one per bibliography entry, not one giant bullet.
- The `citation_display` of any individual `prior_work` row is ≤ 4000 chars (backend) and the rendered `<a>` text is ≤ 480 chars (client).
- Single‑reference papers still get a one‑item Related Work list (no regression).
- Topical clusters group multiple bullets correctly when the model returns cluster IDs (no change in cluster behavior — only the split improved).
- `npm run lint` + `npm run build` pass; `pytest backend/tests/test_citation_resolve.py` (or whatever the existing test file is — add new cases for inline‑marker + sentence‑split if absent) pass.

---

## Don't‑touch list

- Notes path (legacy `Md` + `preprocessLatex`). Out of scope.
- Tier gating (`gating.py`, `multi-qa` feature). Bug 1's per‑request override is a *runtime* check, not a tier change.
- `internalApi.ts` HMAC mechanism (`require_internal` on Python side). Add new endpoints behind the existing auth, don't loosen.
- The OverflowMenu trigger refactor from PROMPT_3 (`triggerInner` + `buttonProps`). Bug 4 builds *inside* that API.
- The model badge / output token budget plumbing from PROMPT_3. Bug 1 layers on top.
- Workspaces / cross‑paper UI. PROMPT_4 Bug 5 hid these; keep them hidden.

---

## Self‑audit checklist before opening a PR

- [ ] No new color, shadow, or motion tokens introduced (search the diff for `bg-`, `text-`, `shadow-`, `duration-`, `border-` and confirm every match already exists elsewhere).
- [ ] No `console.log` left in production paths.
- [ ] Math always flows through `$...$` / `$$...$$` — no bare LaTeX in any rendered string.
- [ ] React 185 doesn't return (PROMPT_3 regression smoke).
- [ ] Heap delta after the 5‑paper smoke is < 80 MB end‑to‑end (PROMPT_4 regression smoke).
- [ ] `npm run lint` and `npm run build` are clean.
- [ ] Pylint / pytest pass (run `pytest backend/tests/test_citation_resolve.py`).
- [ ] Settings dropdown is visible and labeled "Display" on the bottom pane.
- [ ] Background preset hydrates from `/api/settings` on a fresh browser.
- [ ] Cite this doc in the commit message: `Implements docs/COMPOSER_FIX_PROMPT_5.md (bugs 1–5)`.
