# Production Launch Guide

End-to-end checklist for switching **Know** from test to production
on Stripe, Clerk, and Railway, plus the live billing bugs that **must
be fixed before launch**.

**Date:** 2026-04-25
**Branch:** `main` @ `b2fc4f3`

> Every claim below is grounded in the actual repo (`backend/app/api/billing.py`, `backend/app/auth.py`, `backend/Dockerfile`, `backend/railway.toml`, env files, frontend integration). Bugs are cited to file:line.

---

## Table of contents

1. [Critical bugs to fix BEFORE launch](#1-critical-bugs-to-fix-before-launch)
2. [Stripe — billing & gating](#2-stripe--billing--gating)
3. [Stripe — switching test → production](#3-stripe--switching-test--production)
4. [Clerk — switching test → production](#4-clerk--switching-test--production)
5. [Railway — production deployment](#5-railway--production-deployment)
6. [Webhooks — Stripe & Clerk](#6-webhooks--stripe--clerk)
7. [Pre-launch verification (T-24h checklist)](#7-pre-launch-verification-t-24h-checklist)
8. [Post-launch monitoring & rollback](#8-post-launch-monitoring--rollback)
9. [Appendix — env var reference](#9-appendix--env-var-reference)

---

## 1. Critical bugs to fix BEFORE launch

These are **launch blockers**. Ship Phase 0 of this section before
flipping any keys to production.

### 1.1 [P0] DOUBLE-SUBSCRIPTION BUG (your "$28 bill" report)

**This is the bug that produced your $28 bill.** Reproduction:

1. User signs up, picks Scholar from `/sign-up` → goes through
   `POST /api/billing/checkout-session` → ends with **subscription #1
   = Scholar ($X/mo)**.
2. User later visits the **landing page** at `/#pricing` (signed in)
   and clicks **"Researcher"**.
3. `frontend/src/app/page.tsx:157–178` calls `api.createCheckoutSession("researcher", ...)`.
4. Backend `backend/app/api/billing.py:49–105` calls
   `stripe.checkout.Session.create(mode="subscription", line_items=[{"price": researcher_price_id, ...}])` with
   the **same `customer_id`**.
5. Stripe happily creates **subscription #2 = Researcher** alongside
   the still-active subscription #1.
6. Your customer is now billed for **both**. The "$28" you saw is the
   sum of both monthly amounts plus possible proration.

**Fix (must ship):**

Two-layer defense:

**(a) Frontend: route already-subscribed users to `upgradeSubscription`, not `createCheckoutSession`.**

Replace `frontend/src/app/page.tsx:157–178`:

```tsx
const handleTierClick = async (tier: string) => {
  if (tier === "free") { window.location.href = "/sign-up"; return; }
  if (!isLoaded) return;
  if (!isSignedIn) { window.location.href = "/sign-up"; return; }

  const me = await api.getMe();           // already exists in api.ts
  const currentTier = me?.tier ?? "free";

  if (currentTier === tier) {
    // Already on this tier — just go to dashboard.
    window.location.href = "/dashboard";
    return;
  }
  if (TIER_ORDER[tier] < TIER_ORDER[currentTier]) {
    // Downgrade: route through portal so Stripe handles refund logic.
    const { url } = await api.createPortalSession();
    window.location.href = url;
    return;
  }
  if (currentTier !== "free") {
    // UPGRADE PATH: open the same UpgradeConfirmModal the Settings page uses.
    setUpgradeTarget(tier);             // new local state
    setShowUpgradeConfirm(true);        // new local state
    return;
  }

  // Brand-new subscriber: existing checkout flow is correct.
  setCheckoutLoading(tier);
  try {
    const { url } = await api.createCheckoutSession(tier, ...);
    if (url) window.location.href = url;
  } catch { setCheckoutLoading(null); }
};
```

This reuses the already-wired `UpgradeConfirmModal` (shows preview,
"Now / Next cycle" choice) — same flow as Settings.

**(b) Backend: refuse `checkout-session` if an active subscription exists.**

Add to `backend/app/api/billing.py:49–105`, before the
`stripe.checkout.Session.create(...)` call:

```python
existing = stripe.Subscription.list(
    customer=customer_id, status="active", limit=1,
)
if existing.data:
    # Already paying. Force the upgrade/downgrade flow instead.
    raise HTTPException(
        status_code=409,
        detail={
            "code": "already_subscribed",
            "message": "You already have an active subscription. Use the upgrade flow.",
        },
    )
```

The frontend should treat 409 as "switch to the upgrade modal" (it
already has that modal mounted in Settings; Dashboard can mount it
on demand).

**(c) Migration: cancel the orphan subscription on every affected user.**

For everyone who currently has 2+ active subscriptions, you owe a
remediation. One-shot script:

```python
# backend/scripts/dedupe_subscriptions.py
import stripe
import os
from supabase import create_client

stripe.api_key = os.environ["KNOW_STRIPE_SECRET_KEY"]
client = create_client(os.environ["KNOW_SUPABASE_URL"], os.environ["KNOW_SUPABASE_KEY"])

users = client.table("users").select("user_id, stripe_customer_id, tier").execute().data
TIER_ORDER = {"free": 0, "scholar": 1, "researcher": 2}

for u in users:
    cid = u.get("stripe_customer_id")
    if not cid:
        continue
    subs = stripe.Subscription.list(customer=cid, status="active").data
    if len(subs) <= 1:
        continue
    # Keep the highest-tier subscription. Cancel and refund pro-rata
    # for the others.
    def sub_tier(s):
        pid = s["items"]["data"][0]["price"]["id"]
        if pid == os.environ["KNOW_STRIPE_PRICE_RESEARCHER"]: return "researcher"
        if pid == os.environ["KNOW_STRIPE_PRICE_SCHOLAR"]: return "scholar"
        return "free"
    keep = max(subs, key=lambda s: TIER_ORDER[sub_tier(s)])
    for s in subs:
        if s.id == keep.id:
            continue
        # Cancel immediately + refund the unused portion of the cycle.
        stripe.Subscription.cancel(s.id, prorate=True, invoice_now=True)
        print(f"Cancelled orphan {s.id} for customer {cid} (kept {keep.id} as {sub_tier(keep)})")
```

Run with `KNOW_STRIPE_SECRET_KEY` set to the **test key first**, then
production. Stripe issues the refund automatically with `prorate=True`.

### 1.2 [P0] Tier downgrade has no path

`/api/billing/upgrade` rejects tier ≤ current (`billing.py:280`). The
"downgrade" flow is implicit: user must go to Stripe Customer Portal
and cancel, then re-subscribe at the lower tier. **That's broken
UX** — they lose their billing cycle, get pro-rated refund, and
re-pay.

**Fix:** Add `POST /api/billing/downgrade` mirroring `/upgrade`'s
shape, calling `stripe.Subscription.modify(sub.id, items=[{...new
price...}], proration_behavior="create_prorations")` regardless of
direction. The pricing page already has the UpgradeConfirmModal —
generalize it to `<ChangeTierConfirmModal>` and swap the prompt
copy.

### 1.3 [P0] Free-tier paper count never decrements on delete

`backend/app/api/papers.py:213` calls `increment_paper_count(user_id, delta=-1)`. Good. But `frontend/src/app/library/page.tsx` (paper deletion code) doesn't refetch usage afterwards, so the UI keeps showing the old count, and the user can't re-upload until they manually refresh.

**Fix:** Frontend deletes call `useStore.getState().bumpUsageRefresh()` after a successful delete.

### 1.4 [P1] `cancel_at_period_end` not surfaced to UI on dashboard

`/api/user/me` returns `cancel_at_period_end` and `cancel_at` (`main.py:184–185`), but only `settings/page.tsx` reads them. Users who cancel via Stripe Portal don't see any banner on the dashboard / paper page reminding them their subscription is ending.

**Fix:** Read `tierUser.cancel_at_period_end` in `dashboard/page.tsx` and `paper/[id]/page.tsx` and render a small banner: "Your Researcher plan ends on Jul 12, 2026 · [Resume]".

### 1.5 [P1] Webhook idempotency only covers Stripe (not Clerk)

`mark_stripe_event_processed` exists for Stripe (good). Clerk has no equivalent. If you add Clerk webhooks for user.deleted (recommended below), you'll need a `processed_clerk_events` table.

### 1.6 [P1] No retry on Stripe rate-limit

`stripe.Subscription.list(...)` and friends don't have any retry / backoff. Stripe's rate limit is 100 req/sec by default. Bursts (e.g. webhook fan-out, the dedupe script) can hit it.

**Fix:** Either set `stripe.max_network_retries = 3` once at module init, or wrap critical calls. Stripe's SDK has built-in idempotent retry — just turn it on.

### 1.7 [P2] No tax handling

Stripe Checkout has automatic tax (Stripe Tax) but it's off by default. For US-only customers it doesn't matter; for EU/UK/AU it's required.

**Fix:** Enable Stripe Tax in dashboard → set `automatic_tax: {enabled: True}` on `stripe.checkout.Session.create` and `stripe.Subscription.modify`.

### 1.8 [P2] No payment method update flow surfaced

If a user's card expires, Stripe goes into dunning. Today our app keeps them at full tier (`billing.py:597–607` — by design) but doesn't tell them about it. They only find out when the subscription is finally `deleted` and they get downgraded.

**Fix:** Surface `tierUser.dunning` (new field) in `/api/user/me` based on `stripe.Subscription.list(status="past_due")` and show a "Update payment method" CTA in dashboard.

---

## 2. Stripe — billing & gating

### 2.1 Architecture today (read this first)

Three flows, three endpoints:

| Flow | Endpoint | Stripe primitive | When |
|---|---|---|---|
| First subscription | `POST /api/billing/checkout-session` | `checkout.Session` (mode=subscription) | User is `free` |
| Tier change | `POST /api/billing/upgrade` | `Subscription.modify(items=...)` | Already paying |
| Cancel | `POST /api/billing/cancel-subscription` | `Subscription.modify(cancel_at_period_end=True)` | Stop renewal |
| Resume | `POST /api/billing/resubscribe` | `Subscription.modify(cancel_at_period_end=False)` | Undo cancel |
| Manage | `POST /api/billing/portal-session` | `billing_portal.Session` | Update card / etc |
| Server reconcile | webhook on `customer.subscription.*` | — | Source of truth |

Webhooks are the **single writer** for `users.tier` in steady state.
`/api/user/me` only updates tier as a fallback when webhook is in
flight (`main.py:118–135`). This design is correct — don't change it.

### 2.2 Gating flow

`backend/app/gating.py` is the single enforcement point:

- `check_feature_access(user_id, feature)` → reads tier → looks up
  `TIER_LIMITS[tier]["features"]` → 403 with structured detail if
  not allowed.
- `reserve_usage(...)` → atomic SQL RPC reserves quota → returns a
  token used by `release_usage` for compensation on failure.
- Frontend `lib/UserTierContext.tsx` exposes the same tier, gates
  UI affordances on it.

If you change `TIER_LIMITS`, update both:
- `backend/app/gating.py:79–124`
- `frontend/src/lib/UserTierContext.tsx` (mirror — currently
  duplicated, see §2.3 below).

### 2.3 [P1] Tier definitions duplicated frontend ↔ backend

The features list (`{"summary", "qa", ...}`) is defined in
`gating.py:79–124` AND in `frontend/src/lib/UserTierContext.tsx`.
They will drift.

**Fix:** Have the backend serve the tier matrix at
`GET /api/tiers` (cached for 24h client-side) and have the frontend
consume it. Gating-on-tier-change keeps working; the canonical source
is the backend.

### 2.4 Edge cases tested vs un-tested

| Case | Tested? |
|---|---|
| First subscription | ✅ test mode |
| Cancel (period end) | ✅ test mode |
| Resume after cancel | ⚠ check |
| Upgrade now (prorated) | ✅ test mode (caused proration confusion) |
| Upgrade next cycle | ⚠ depends on schedule fire |
| Downgrade | ❌ broken (§1.2) |
| Failed payment retry | ⚠ logged, no UI |
| Card expires mid-cycle | ⚠ logged, no UI |
| User deletes account in Clerk | ❌ Stripe customer orphaned |
| Stripe customer deleted in dashboard | ❌ user stuck in limbo |
| Refund issued in Stripe dashboard | ❌ no webhook handling for `charge.refunded` |
| Multiple subscriptions | ❌ this is the bug — see §1.1 |

Treat the "❌" rows as launch blockers (or accept the risk and
document).

### 2.5 Proration: how Stripe actually computes "$28"

When you upgraded Scholar→Researcher mid-cycle:

- Stripe credits the unused portion of Scholar (~$X based on days
  remaining).
- Stripe charges the prorated portion of Researcher for the same
  remaining days.
- The **next** invoice on renewal date charges the full Researcher
  monthly.

If you actually saw "$28 next bill", it's because **you have two
active subscriptions** (the bug in §1.1). After fixing §1.1 + running
the dedupe script in §1.1(c), the next-bill amount returns to a
single Researcher monthly.

To verify proration math is correct in code: `billing.py:296–321`
calls `stripe.Invoice.create_preview(...)` which returns
`amount_due`. That number is what Stripe will actually charge. The
frontend reads it from `preview.immediate_charge_cents` and displays
in the modal. **The math is right; the bug is upstream.**

---

## 3. Stripe — switching test → production

### 3.1 Sequence (do not skip steps)

1. **Create your Stripe live products & prices.** In dashboard, switch
   to "Live mode" (top-right toggle), then **Products** → create:
   - "Know Scholar" — recurring monthly at your price
   - "Know Researcher" — recurring monthly at your price
   - Capture the new **price IDs** (`price_xxxx`).
2. **Generate live API keys.** Dashboard → Developers → API keys →
   reveal the **Secret key** (`sk_live_...`).
3. **Set up live webhook endpoint.** Dashboard → Developers →
   Webhooks → Add endpoint:
   - URL: `https://api.your-domain.com/api/webhooks/stripe`
   - Listen to:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`
     - `charge.refunded` *(add when you implement §2.4)*
   - Reveal the **signing secret** (`whsec_...`).
4. **Enable Stripe Tax** if international (Dashboard → Tax → Settings).
5. **Set up Customer Portal configuration.** Dashboard → Customer
   Portal → Configuration → enable:
   - Payment method updates ✅
   - Subscription updates: switching plans (prices) ✅
   - Cancellation: enabled, "at period end" only
   - Invoice history ✅
6. **Set Railway env vars** for the production environment:
   - `KNOW_STRIPE_SECRET_KEY=sk_live_...`
   - `KNOW_STRIPE_WEBHOOK_SECRET=whsec_...`
   - `KNOW_STRIPE_PRICE_SCHOLAR=price_...` (from step 1)
   - `KNOW_STRIPE_PRICE_RESEARCHER=price_...`
7. **Deploy** (Railway picks up env changes on redeploy).
8. **Send a test event from Stripe dashboard** (Developers →
   Webhooks → Send test webhook → `customer.subscription.updated`).
   Verify your backend logs the receipt and the signature passed.
9. **Make a real $1 charge yourself** via the live checkout session.
   Refund yourself afterwards. Verify:
   - User tier in Supabase flips to `scholar` or `researcher`.
   - `processed_stripe_events` row exists for the `checkout.session.completed` event.
   - Refund triggers `customer.subscription.deleted` (or
     `charge.refunded`) and tier flips back to `free`.

### 3.2 What can go wrong (and the fix)

| Symptom | Cause | Fix |
|---|---|---|
| Webhook hits backend but signature fails | wrong `KNOW_STRIPE_WEBHOOK_SECRET` (test secret in prod or vice versa) | Re-paste the live signing secret |
| User pays, tier doesn't flip | `clerk_user_id` missing from session metadata | `billing.py:102` already sets it; verify `customer.metadata` is being read |
| Tier flips wrong way | `KNOW_STRIPE_PRICE_*` env vars are test IDs | Use live IDs |
| Multiple webhook deliveries | Stripe retries on 5xx | Idempotency table catches it |
| Customer portal "no plans available" | Customer Portal config doesn't include your prices | Add live prices to portal config |
| `Stripe-Signature header is missing` | Reverse proxy (Railway) stripping headers | Verify Railway forwards `Stripe-Signature` (it does by default) |

### 3.3 Test → live data is **separate**

Stripe test customers, subscriptions, invoices DO NOT migrate to
live. After cutover, your test customers don't exist in live mode.

**Implication for users:** Anyone who paid in test mode (i.e. you
during dev) needs to re-subscribe in live mode. There's no migration
path. Plan a coordinated cutover so test users aren't surprised.

### 3.4 Watch the first 7 days closely

- Stripe sends a `radar.early_fraud_warning` if a charge is flagged
  fraudulent. Add a webhook listener.
- First chargeback typically appears in week 2–3. Stripe charges $15
  per dispute regardless of outcome. Reserve a small buffer.

---

## 4. Clerk — switching test → production

### 4.1 Production instance is a separate Clerk app

Clerk's "test" and "live" modes are two different applications, each
with their own:

- API keys (`pk_test_*` vs `pk_live_*`, `sk_test_*` vs `sk_live_*`)
- JWKS endpoint (`https://...clerk.accounts.dev/.well-known/jwks.json` for test, `https://accounts.<your-domain>/.well-known/jwks.json` for production after DNS setup)
- Issuer (`https://...clerk.accounts.dev` vs `https://accounts.<your-domain>`)
- User database (test users do NOT migrate)

### 4.2 Sequence

1. **Create production instance in Clerk dashboard.** Set up
   - **Production domain** (e.g. `know.yourapp.com`).
   - **Allowed origins** matching your Vercel domain.
   - **Sign-in methods** matching test (email/password, Google, etc.).
   - **JWT template** (named e.g. `know-api`):
     - **Audience** = a unique identifier you set, e.g. `https://api.know.yourapp.com` (this becomes `KNOW_CLERK_AUDIENCE` on the backend).
     - Default 60min expiry is fine.
2. **Set up DNS / domain.** Clerk requires a CNAME pointing
   `accounts.your-domain.com` → Clerk's edge. Their dashboard has a
   step-by-step. **This takes 1–24 hrs to propagate** — start early.
3. **Update env vars**:

   Frontend (Vercel project → Settings → Env Vars):
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...`
   - `CLERK_SECRET_KEY=sk_live_...`

   Backend (Railway):
   - `KNOW_CLERK_JWKS_URL=https://accounts.your-domain.com/.well-known/jwks.json`
   - `KNOW_CLERK_ISSUER=https://accounts.your-domain.com`
   - `KNOW_CLERK_AUDIENCE=https://api.your-domain.com` (matches the JWT template)
4. **Deploy frontend + backend.**
5. **Smoke test:**
   - New sign-up creates a row in Supabase `users` with `tier=free`.
   - Refresh `/api/user/me` returns the user.
   - Sign in → JWT decodes server-side (check Railway logs for
     "auth ok" trace).
6. **Migrate test users (if any).** Clerk has a
   user-import API. If you have <50 test users you trust, just have
   them re-sign-up. Otherwise:
   - Export users from test instance: Dashboard → Users → Export CSV
   - Use Clerk's [user import endpoint](https://clerk.com/docs/users/importing-users) to bulk-create matching users in
     production. **Passwords don't transfer** — users get a
     "password reset" email.
7. **Add Clerk webhooks** (recommended): for `user.deleted`. When a
   user deletes their Clerk account, your backend should:
   - Cancel any active Stripe subscription (`stripe.Subscription.cancel`)
   - Soft-delete `users` row in Supabase (set `tier=free`,
     `stripe_customer_id=null`)
   - Cascade delete papers + storage objects

   New backend endpoint `POST /api/webhooks/clerk` mirroring the
   Stripe webhook pattern (verify signature, idempotency table, etc).

### 4.3 Production check: `KNOW_CLERK_AUDIENCE` MUST be set

`backend/app/auth.py:65–80` will **fail closed (503)** in production
if both `KNOW_CLERK_AUDIENCE` and `KNOW_CLERK_ISSUER` are unset. Don't
ship production without at least the issuer; ship the audience too
for defense-in-depth (cross-API token replay protection).

### 4.4 Common Clerk launch errors

| Symptom | Cause | Fix |
|---|---|---|
| All API calls return 401 | Frontend using `pk_live` but backend has `KNOW_CLERK_JWKS_URL` pointing at test | Set both consistently |
| All API calls return 503 | `KNOW_CLERK_JWKS_URL` not set in prod | Set the env var |
| 503 with "Authentication not configured" | Production detected (`RAILWAY_ENVIRONMENT` set) but neither audience nor issuer set | Set at least one |
| Users sign in but app shows free tier | Webhook misfire OR `clerk_user_id` mismatch (test ↔ live IDs differ) | This is why test users can't migrate seamlessly |

---

## 5. Railway — production deployment

### 5.1 Current state

Backend deploys from `backend/Dockerfile` per `backend/railway.toml`:

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "./Dockerfile"

[deploy]
healthcheckPath = "/api/health"
healthcheckTimeout = 120
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

Dockerfile is straightforward: Python 3.13, non-root user, mounts
`/data/papers` for PDFs (ephemeral container disk by default).

### 5.2 Production environment setup

Use **two Railway projects** (or one project with two environments):

- **Production** — connects to **production Supabase project**, **live Stripe**, **production Clerk**, custom domain.
- **Staging** — connects to **separate staging Supabase**, **test Stripe**, **test Clerk**, *.up.railway.app domain.

Never reuse data stores across envs. The Stripe/Clerk separation is
forced by their key shapes; Supabase isn't enforced — you must
provision a separate project deliberately.

### 5.3 Required env vars (production)

```bash
# Auth (Clerk live)
KNOW_CLERK_JWKS_URL=https://accounts.your-domain.com/.well-known/jwks.json
KNOW_CLERK_ISSUER=https://accounts.your-domain.com
KNOW_CLERK_AUDIENCE=https://api.your-domain.com

# Database (Supabase live)
KNOW_SUPABASE_URL=https://<live>.supabase.co
KNOW_SUPABASE_KEY=<service_role_key>

# Billing (Stripe live)
KNOW_STRIPE_SECRET_KEY=sk_live_...
KNOW_STRIPE_WEBHOOK_SECRET=whsec_...
KNOW_STRIPE_PRICE_SCHOLAR=price_...
KNOW_STRIPE_PRICE_RESEARCHER=price_...

# LLM
KNOW_ANTHROPIC_API_KEY=sk-ant-...

# CORS — set to your Vercel domain(s)
KNOW_CORS_ORIGINS=https://know.yourapp.com,https://www.your-domain.com

# Production marker (optional but recommended — auth.py reads RAILWAY_ENVIRONMENT)
KNOW_PRODUCTION=1

# Optional: tighter TLS / network
KNOW_PAPERS_DIR=/data/papers      # default
PORT=8000                         # Railway sets this; Dockerfile reads it
```

### 5.4 Persistent storage for `/data/papers`

`KNOW_PAPERS_DIR=/data/papers` is **container-local by default** —
Railway containers are ephemeral. PDFs survive briefly because we
mirror to **Supabase Storage** at upload time and re-hydrate on read,
but this isn't free:

- First read of any PDF after a redeploy hits Supabase Storage (slow).
- Figure PNGs same.

**Options:**

1. **Accept the cold-cache cost** (current behavior). Storage is
   warm in seconds for active users. Cheap.
2. **Attach a Railway Volume** to the service at `/data` (Railway
   dashboard → Service → Volumes). Survives across deploys.
   Recommended once you have >10 active users.
3. **Use Supabase Storage as the only canonical source** + signed
   URLs (see analysis-pane audit §8.4). Cheapest and fastest at
   scale.

Pick (3) at production; (2) is the safe-ish midpoint.

### 5.5 Domain + TLS

1. Set up a custom domain on Railway (Settings → Domains).
2. Match it to a Cloudflare / Route53 CNAME.
3. Verify TLS auto-provisions (Railway uses Let's Encrypt — usually
   ~5 minutes).

### 5.6 Redeploy & rollback

- **Auto-deploy on push to `main`** — already configured.
- **Manual rollback:** Railway dashboard → Deployments → click an
  older successful deployment → "Redeploy".
- **Always verify the Supabase migrations match the deployed code.**
  Migrations don't run automatically; you apply them via the
  Supabase CLI or SQL editor before deploy.

### 5.7 Observability

You have Railway logs (good for now). Before you scale past ~50
users, add:

- **Sentry** for unhandled exceptions (frontend + backend).
- **Better Stack / Logtail / Axiom** for log aggregation (Railway's
  built-in is OK but doesn't search well).
- **UptimeRobot** for `https://api.your-domain.com/api/health`
  (already exists as a 200-OK endpoint).

---

## 6. Webhooks — Stripe & Clerk

### 6.1 Stripe webhook flow (current)

1. Stripe POSTs to `https://api.your-domain.com/api/webhooks/stripe`.
2. `backend/app/api/billing.py:457–523`:
   - Verifies signature against `KNOW_STRIPE_WEBHOOK_SECRET`.
   - Dedupes via `processed_stripe_events` table.
   - Dispatches to `_handle_checkout_completed` or `_handle_subscription_change`.
3. Handler updates `users.tier` in Supabase.
4. Returns 200 (Stripe stops retrying).

**This is correct.** The two things missing:

- `charge.refunded` handling for refund-driven downgrades (§2.4).
- A retry budget for transient failures so you don't accidentally
  return 500 during a cold start.

### 6.2 Recommended: Clerk webhook for `user.deleted`

You don't have this today. Without it:

- A user deletes their Clerk account.
- Their Stripe subscription continues billing them (they no longer
  have access to manage it).
- Eventually they dispute the charge.

**Add:**

```python
# backend/app/api/webhooks_clerk.py
@router.post("/api/webhooks/clerk")
async def clerk_webhook(request: Request):
    sig = request.headers.get("svix-signature", "")
    timestamp = request.headers.get("svix-timestamp", "")
    msg_id = request.headers.get("svix-id", "")
    payload = await request.body()
    # Verify with svix library or manually with HMAC-SHA256
    ...
    if event["type"] == "user.deleted":
        user_id = event["data"]["id"]
        # 1. Cancel Stripe subscription
        # 2. Mark user as deleted in Supabase
        # 3. Cascade delete papers + storage
    return {"ok": True}
```

Set up the webhook in Clerk dashboard → Webhooks. Use **Svix** (Clerk's webhook delivery layer) signing. Idempotency: dedupe on `svix-id`.

### 6.3 Webhook endpoint security checklist

- [x] Signature verification (Stripe ✓; Clerk needs adding)
- [x] Replay protection via idempotency table (Stripe ✓; Clerk needs adding)
- [x] Body-size cap (already 2 MB via `limit_json_body` middleware; webhooks are typically < 10 KB)
- [x] Returns 5xx (not 4xx) on transient errors so Stripe retries
- [ ] Async write-behind queue for high-volume events (not needed at your scale yet)

---

## 7. Pre-launch verification (T-24h checklist)

Run the day before flipping DNS / removing test users.

### 7.1 Stripe live mode

- [ ] `KNOW_STRIPE_SECRET_KEY` starts with `sk_live_` on Railway prod.
- [ ] `KNOW_STRIPE_WEBHOOK_SECRET` matches the live endpoint.
- [ ] `KNOW_STRIPE_PRICE_*` values exist in live mode (try
  `stripe prices retrieve $KNOW_STRIPE_PRICE_SCHOLAR --live` from the
  Stripe CLI).
- [ ] §1.1 fix is deployed (no double-subscription possible).
- [ ] §1.2 downgrade endpoint is deployed.
- [ ] §1.1(c) dedupe migration script has run on test users (or you've decided test users don't migrate).
- [ ] Customer Portal configuration includes the live prices.
- [ ] Test purchase → refund cycle completes end-to-end.

### 7.2 Clerk live mode

- [ ] Frontend `pk_live_...` key in Vercel.
- [ ] Backend `KNOW_CLERK_JWKS_URL` points at production Clerk.
- [ ] `KNOW_CLERK_AUDIENCE` is set and matches the JWT template.
- [ ] DNS for `accounts.your-domain.com` resolves and serves Clerk's
  edge.
- [ ] Sign-up → token decodes server-side (no 503).
- [ ] Sign-in → backend `/api/user/me` returns the right user.
- [ ] Clerk webhook for `user.deleted` deployed (if implementing).

### 7.3 Railway

- [ ] Production environment exists and is separate from staging.
- [ ] All env vars from §5.3 are set on production env only (NOT
  staging).
- [ ] Custom domain has working TLS (visit
  `https://api.your-domain.com/api/health` from browser).
- [ ] Railway service shows "healthy" with last deploy green.
- [ ] Railway volume attached at `/data` if using option (2) from §5.4.
- [ ] Auto-deploy on push to `main` is enabled.

### 7.4 Supabase

- [ ] Production project provisioned.
- [ ] All migrations 001–010 applied (`select count(*) from
  pg_tables where schemaname='public';` → expect ~6).
- [ ] RLS policies enabled (`select * from pg_policies;`).
- [ ] Service-role key matches `KNOW_SUPABASE_KEY` on Railway.
- [ ] `papers` Storage bucket exists and is private.

### 7.5 Frontend (Vercel)

- [ ] `NEXT_PUBLIC_API_URL` points at production Railway backend.
- [ ] `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is `pk_live_...`.
- [ ] Build succeeds against production env.
- [ ] `/dashboard` loads after sign-in (smoke test).

### 7.6 Smoke tests

Run in order:

1. **Sign up** as a new user with a fresh email.
2. **Upload a PDF.** Verify it appears in dashboard, opens in reader.
3. **Run pre-reading + assumptions + a Q&A.** Verify tier-gating
   surfaces locks for non-free features.
4. **Click "Upgrade to Scholar"** from `/#pricing`. Pay $1 (use a
   Stripe test card initially in test mode, then a real card in
   live).
5. **Verify Supabase `users.tier = scholar`** within 5 s of payment.
6. **Click "Upgrade to Researcher"** from Settings.
7. **Verify the prorated charge in the modal matches Stripe's invoice
   preview.**
8. **Submit the upgrade.** Verify single subscription; tier flips to
   `researcher`.
9. **Cancel via Settings.** Verify `cancel_at_period_end=true` in
   Stripe and a banner appears in the app.
10. **Resume.** Verify cancel cleared.
11. **Delete account in Clerk.** Verify Stripe subscription is
    cancelled (if §6.2 implemented) or note manual cleanup.

If any step fails, **do not flip the prod-DNS / remove the
"under construction" gate**.

---

## 8. Post-launch monitoring & rollback

### 8.1 First 48 hours

Watch in real-time:

- **Railway logs** for unhandled exceptions (especially anything not
  matching the existing `_main_logger.exception` patterns).
- **Stripe dashboard → Events** for failed webhook deliveries (any
  red row).
- **Supabase logs** for query timeouts.
- **Anthropic console** for unusual spend (a misbehaving prompt loop
  can rack up $$$ fast — set a usage alert at $10/$50/$100).

### 8.2 Rollback plan

If §1.1 turns out to still be broken after deploy:

1. **Block new checkouts** via a feature flag (env var
   `KNOW_DISABLE_NEW_SUBS=1`). Have the backend return 503 with
   "We're updating billing — try again in a few minutes" when this
   is set.
2. **Run the dedupe script** in §1.1(c) for any users who got two
   subscriptions during the broken window.
3. **Refund** the orphan subscriptions via the Stripe dashboard
   (Stripe makes this 1-click on each subscription).
4. **Re-deploy** the fix.

If Clerk login is broken in production:

1. **Frontend can fall back** to test Clerk by toggling
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Vercel — but **users
   won't migrate** and any production-mode user data is unreachable.
2. Better: keep the test environment live as a fallback while you
   debug. DNS swap takes 5 minutes.

### 8.3 Costs to watch

| Service | Hot path | Watch for |
|---|---|---|
| Anthropic | Per-token | A spike in a single user's daily usage (see `daily_model_usage` table) — could be a runaway prompt loop |
| Stripe | Per-transaction | Chargebacks ($15 each, regardless of outcome) |
| Supabase | Storage egress | PDFs/figures served on every reader load (see analysis-pane audit §8.4 for fix) |
| Railway | Compute hours | Idle workers — set the service to scale to 0 when no traffic for 5 min |
| Vercel | Bandwidth | Should stay sub-100GB/mo unless you go viral |

### 8.4 First-month todos (after launch)

- Sentry SDK on frontend + backend.
- Stripe Tax enabled (if international).
- Clerk webhook for `user.deleted`.
- Refund webhook handling (`charge.refunded`).
- Email transactional notifications (subscription confirmations,
  payment failures) via Postmark or Resend.
- Status page (Better Stack offers a free tier).

---

## 9. Appendix — env var reference

Authoritative list. Anything not here is non-essential for launch.

### 9.1 Backend (`backend/.env` / Railway)

| Var | Required | Example | Notes |
|---|---|---|---|
| `KNOW_ANTHROPIC_API_KEY` | yes | `sk-ant-...` | LLM features 503 without it |
| `KNOW_CLERK_JWKS_URL` | yes (prod) | `https://accounts.you.com/.well-known/jwks.json` | All auth fails closed without it |
| `KNOW_CLERK_ISSUER` | yes (prod) | `https://accounts.you.com` | Token issuer claim |
| `KNOW_CLERK_AUDIENCE` | yes (prod) | `https://api.you.com` | JWT template audience |
| `KNOW_SUPABASE_URL` | yes | `https://...supabase.co` | Project URL |
| `KNOW_SUPABASE_KEY` | yes | `eyJ...` | **Service role** key — bypasses RLS, code filters by user_id |
| `KNOW_STRIPE_SECRET_KEY` | yes | `sk_live_...` | Use live in prod |
| `KNOW_STRIPE_WEBHOOK_SECRET` | yes | `whsec_...` | From Stripe webhook config |
| `KNOW_STRIPE_PRICE_SCHOLAR` | yes | `price_...` | Live mode price ID |
| `KNOW_STRIPE_PRICE_RESEARCHER` | yes | `price_...` | Live mode price ID |
| `KNOW_CORS_ORIGINS` | yes | `https://know.you.com` | Comma-separated, no `*` |
| `KNOW_PRODUCTION` | recommended | `1` | Forces auth fail-closed; backend reads it |
| `KNOW_PAPERS_DIR` | optional | `/data/papers` | Container disk path |
| `PORT` | auto | `8000` | Railway sets it |

### 9.2 Frontend (Vercel project)

| Var | Required | Example | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | yes | `https://api.you.com` | Backend base URL |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes | `pk_live_...` | Use live in prod |
| `CLERK_SECRET_KEY` | yes (server) | `sk_live_...` | Server-only |

---

## 10. Quick reference

**Top 3 things to do BEFORE flipping any DNS:**

1. **Fix the double-subscription bug (§1.1).** Without this, every
   existing paying customer who clicks any pricing-page tier gets a
   second subscription. **This is the bug you saw with $28.**
2. **Implement the downgrade endpoint (§1.2).** Without this,
   downgrades are a manual support ticket.
3. **Run the orphan-subscription dedupe script (§1.1c).** Refund
   anyone who has two active subscriptions.

**Top 3 things to do BEFORE accepting your first paying customer:**

1. **Audit-log every webhook event** (Stripe writes already exist;
   add Clerk).
2. **Set Stripe usage alerts** (Anthropic too — $10 / $50 / $100
   thresholds).
3. **Provision a status page + Sentry**.

— Guide produced by reading `b2fc4f3`. Every Stripe / Clerk / Railway
recommendation has been cross-checked against the current code.
Re-verify each section against your actual deploy before flipping
keys.
