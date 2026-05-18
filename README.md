# Know

Interactive academic paper reader with AI-powered analysis. Upload a PDF, get clean LaTeX-rich markdown, and use AI tools to study it: pre-reading prep, derivation exercises, assumptions analysis, Q&A, figure conversations, notes, and more.

## Architecture

- **Frontend**: Next.js 15 (App Router) on Vercel, Tailwind CSS, shadcn/ui, Streamdown + KaTeX, Clerk auth.
- **AI streaming**: Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/gateway`) on Next.js route handlers. Selection, summary, figure-Q&A, and authenticated chat all stream from the Vercel side via `streamObject` against typed Zod schemas. Anthropic prompt caching and AI Gateway provider routing are first-class.
- **Backend**: Python FastAPI on Railway. Owns paper upload, PDF parse, figure extraction, batch analysis (`analyze`, `assumptions`, `ask`, `ask-multi`), tier gating, billing, and the anonymous trial flow. Single source of truth for usage caps via `gating.py`.
- **Persistence**: Supabase Postgres with RLS for users / papers / workspaces / billing rows. Vercel Marketplace Redis (Upstash) for token cache, idempotency keys, and trial rate-limit buckets.
- **Cron**: Vercel Cron (`/api/cron/cleanup-trial`) handles daily cleanup; the in-process FastAPI loop is kept as a gated fallback (`KNOW_DISABLE_INTERNAL_CRON_FALLBACK`).

```
Browser ──► Next.js (Vercel)
              ├─► AI SDK route handlers (streaming):
              │     /api/papers/[id]/selection-stream
              │     /api/papers/[id]/summary-stream
              │     /api/papers/[id]/figure-qa-stream
              ├─► AI Gateway → Anthropic (Sonnet/Haiku/vision)
              ├─► Upstash Redis (cache, idempotency, rate limits)
              ├─► Supabase (server-side reads with service role)
              └─► Python /api/internal/* (HMAC bearer; usage,
                  paper context, figure bytes, cleanup callback)

Browser ──► Python (Railway)
              ├─► Paper upload, parse, figure extraction
              ├─► Batch analysis + Q&A endpoints
              ├─► Settings, billing, search, library
              ├─► Trial flow (rate-limited via Vercel KV proxy)
              └─► /api/internal/* (server-to-server)
```

## Quick start (local)

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with KNOW_ANTHROPIC_API_KEY, KNOW_SUPABASE_*, KNOW_CLERK_*, KNOW_INTERNAL_BACKEND_TOKEN
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
cp .env.example .env.local
# Edit .env.local with ANTHROPIC_API_KEY (or AI_GATEWAY_API_KEY),
# CLERK_*, SUPABASE_*, INTERNAL_BACKEND_*, KV_REST_API_*
npm install
npm run dev
```

Open <http://localhost:3000>.

## Production deployment

The deploy is split: **Next.js on Vercel**, **Python on Railway**, **Postgres + Storage on Supabase**, **Redis from the Vercel Marketplace**. There is no longer a self-hosted Mac-Studio + Ollama path — everything runs on managed infra.

### 1. Vercel (frontend)

Set these env vars in Vercel → Settings → Environment Variables (Production + Preview + Development):

| Name | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | One of these | Direct Anthropic key. Skip if AI Gateway is enabled. |
| `AI_GATEWAY_API_KEY` | One of these | Vercel AI Gateway key. Auto-detected via OIDC inside a Vercel deploy. |
| `MODEL_ANALYSIS` | optional | Default `claude-sonnet-4-6`. |
| `MODEL_FAST` | optional | Default `claude-haiku-4-5`. |
| `MODEL_VISION` | optional | Default `claude-sonnet-4-6`. |
| `INTERNAL_BACKEND_URL` | yes | Public URL of the Python service (e.g. `https://your-api.up.railway.app`). |
| `INTERNAL_BACKEND_TOKEN` | yes | Strong random secret (`openssl rand -hex 32`). Same value on Railway as `KNOW_INTERNAL_BACKEND_TOKEN`. |
| `SUPABASE_URL` | yes | Same as `KNOW_SUPABASE_URL` on the backend. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase → Project Settings → API → service_role. Privileged. |
| `CLERK_SECRET_KEY` | yes | Clerk dashboard → API Keys. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | Same source. |
| `KV_REST_API_URL` | yes (auto) | Auto-injected by the Upstash integration. |
| `KV_REST_API_TOKEN` | yes (auto) | Same. |
| `CRON_SECRET` | yes | Vercel auto-generates this when you add a cron entry. |

Add the Upstash Redis integration: **Vercel → Storage → Create Database → Marketplace → Upstash for Redis → Connect to project**.

Then deploy:

```bash
cd frontend
npx vercel --prod
```

### 2. Railway (backend)

Deploy the `backend/` directory; Railway picks up `Dockerfile` automatically. Required env vars:

| Name | Notes |
|---|---|
| `KNOW_ANTHROPIC_API_KEY` | Used by the trial flow + remaining batch endpoints. |
| `KNOW_SUPABASE_URL` / `KNOW_SUPABASE_KEY` | Shared with the Vercel side. |
| `KNOW_CLERK_*` | JWKS / issuer / audience for `/api/...` JWT verify. |
| `KNOW_STRIPE_*` | Billing + webhook secret. |
| `KNOW_INTERNAL_BACKEND_TOKEN` | Same value as Vercel's `INTERNAL_BACKEND_TOKEN`. |
| `KNOW_NEXTJS_RATELIMIT_URL` | Set to your Vercel deploy URL once `/api/trial/rate-check` is live. |
| `KNOW_DISABLE_INTERNAL_CRON_FALLBACK` | Set to `1` once Vercel Cron at `/api/cron/cleanup-trial` is verified running. |
| `KNOW_CORS_ORIGINS` | Comma-separated list of allowed origins (your Vercel domain). |

### 3. Supabase

Apply the migrations in `backend/supabase/migrations/` to your Supabase project.

### 4. Verify

- `curl https://<your-vercel>/api/health/llm` → `{"ok": true, ...}`.
- `curl -H "Authorization: Bearer $TOKEN" https://<your-railway>/api/internal/paper/<id>/text?user_id=<user>` → 200.
- Sign in, upload a paper, click Explain on a passage. Watch the Network tab — the request should hit `<your-vercel>/api/papers/[id]/selection-stream`, not Railway.

## Key paths

| Concern | Path |
|---|---|
| LLM streaming routes | `frontend/src/app/api/papers/[id]/*-stream/route.ts` |
| Server-side LLM helpers | `frontend/src/lib/server/{llm,kv,supabase,auth,internalApi,observability,schemas,prompts/}.ts` |
| Streaming UI | `frontend/src/components/analysis/{StreamingMarkdown,AnalysisSection,OverflowMenu}.tsx` + `useSelectionThread.ts` |
| Internal Python router | `backend/app/api/internal.py` |
| Tier gating | `backend/app/gating.py` |
| Trial flow | `backend/app/main.py` (`/api/trial/*`) + `frontend/src/app/api/trial/rate-check/route.ts` |
| Cron | `frontend/src/app/api/cron/cleanup-trial/route.ts` |

## Repository docs

- `docs/COMPOSER_BRIEF.md` — implementation brief for the AI SDK migration / analysis-pane refactor.
- `docs/PRODUCTION_LAUNCH_GUIDE.md` — deployment checklist.
- `.cursor/rules/{architecture,latex,analysis-pane}.mdc` — always-applied rules for any agent touching this repo.

## License

See `LICENSE`. Built by [@espitia01](https://github.com/espitia01).
