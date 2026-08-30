"""API routes for Stripe billing: checkout, portal, and webhooks."""

from __future__ import annotations

import logging
import os
import stripe
from fastapi import APIRouter, HTTPException, Request, Depends

from ..config import settings
from ..auth import require_auth
from ..services.db import (
    get_user,
    update_user_tier,
    update_user_stripe_customer,
    get_user_by_stripe_customer,
    get_or_create_user,
    store_cancellation_feedback,
    store_feedback,
    is_stripe_event_processed,
    mark_stripe_event_processed,
    StripeDedupError,
)

MAX_CANCEL_REASON = 200
MAX_CANCEL_FEEDBACK = 2000
MAX_FEEDBACK_MESSAGE = 5000

logger = logging.getLogger(__name__)

router = APIRouter(tags=["billing"])

PRICE_TO_TIER: dict[str, str] = {}


TIER_ORDER = {"free": 0, "scholar": 1, "researcher": 2}
CURRENT_SUB_STATUSES = frozenset({"active", "trialing", "past_due", "unpaid", "paused"})


def _init_stripe():
    if settings.stripe_secret_key:
        stripe.api_key = settings.stripe_secret_key
        stripe.max_network_retries = 3
    if settings.stripe_price_scholar:
        PRICE_TO_TIER[settings.stripe_price_scholar] = "scholar"
    if settings.stripe_price_researcher:
        PRICE_TO_TIER[settings.stripe_price_researcher] = "researcher"
    logger.info("Stripe init: PRICE_TO_TIER=%s", PRICE_TO_TIER)


_init_stripe()


def redirect_hosts() -> set[str]:
    """Hosts allowed in Stripe success/cancel/return URLs.

    Checkout used to allow only ``localhost:3000`` plus a manually parsed
    CORS list. Production deploys that set ``KNOW_NEXTJS_RATELIMIT_URL``
    but forgot a host in CORS would 400 every checkout with
    "Invalid redirect URL".
    """
    from urllib.parse import urlparse

    hosts = {"localhost:3000", "127.0.0.1:3000"}

    def _add(raw: str) -> None:
        raw = (raw or "").strip()
        if not raw:
            return
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
        host = parsed.netloc
        if not host:
            return
        hosts.add(host)
        hostname = parsed.hostname or host.split(":")[0]
        if hostname.startswith("www."):
            hosts.add(host.replace("www.", "", 1))
        else:
            rest = host[len(hostname):]
            hosts.add(f"www.{hostname}{rest}")

    extra = os.environ.get("KNOW_CORS_ORIGINS", "") or getattr(settings, "cors_origins", "") or ""
    for origin in extra.split(","):
        _add(origin)
    _add(getattr(settings, "nextjs_ratelimit_url", "") or "")
    return hosts


def is_safe_redirect_url(url: str, hosts: set[str] | None = None) -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        return False
    allowed = hosts if hosts is not None else redirect_hosts()
    host = parsed.netloc
    if host in allowed:
        return True
    hostname = parsed.hostname or ""
    if hostname.startswith("www.") and host.replace("www.", "", 1) in allowed:
        return True
    if hostname and f"www.{host}" in allowed:
        return True
    return False


def _sub_status(sub) -> str:
    if isinstance(sub, dict):
        return str(sub.get("status") or "")
    return str(getattr(sub, "status", "") or "")


def _sub_id(sub) -> str:
    if isinstance(sub, dict):
        return str(sub.get("id") or "")
    return str(getattr(sub, "id", "") or "")


def _sub_price_id(sub) -> str:
    try:
        items = sub["items"]["data"]
        if not items:
            return ""
        price = items[0]["price"]
        if isinstance(price, str):
            return price
        if isinstance(price, dict):
            return str(price.get("id") or "")
        return str(getattr(price, "id", "") or "")
    except Exception:
        return ""


def _list_current_subscriptions(customer_id: str):
    """Subscriptions that still bill — not canceled / incomplete_expired."""
    subs = stripe.Subscription.list(customer=customer_id, limit=20)
    return [s for s in subs.data if _sub_status(s) in CURRENT_SUB_STATUSES]


def _cancel_subscription(sub) -> None:
    sid = _sub_id(sub)
    try:
        stripe.Subscription.cancel(sid, prorate=True, invoice_now=True)
    except TypeError:
        stripe.Subscription.delete(sid)


def dedupe_customer_subscriptions(customer_id: str, prefer_price_id: str | None = None) -> int:
    """Keep one live subscription; prorate-cancel the rest.

    This is the server-side fix for the double-checkout bug: a signed-in
    Scholar who clicked Researcher on the landing page used to get a
    second Checkout Session on the same customer.
    """
    current = _list_current_subscriptions(customer_id)
    if len(current) <= 1:
        return 0
    keep = None
    if prefer_price_id:
        keep = next((s for s in current if _sub_price_id(s) == prefer_price_id), None)
    if keep is None:
        keep = max(
            current,
            key=lambda s: TIER_ORDER.get(PRICE_TO_TIER.get(_sub_price_id(s), "free"), 0),
        )
    keep_id = _sub_id(keep)
    cancelled = 0
    logger.error(
        "Customer %s has %d live subscriptions; keeping %s",
        customer_id,
        len(current),
        keep_id,
    )
    for s in current:
        if _sub_id(s) == keep_id:
            continue
        try:
            _cancel_subscription(s)
            cancelled += 1
        except stripe.StripeError:
            logger.exception("Failed to cancel orphan subscription %s", _sub_id(s))
    return cancelled


def _load_current_subscription(customer_id: str):
    current = _list_current_subscriptions(customer_id)
    if len(current) > 1:
        dedupe_customer_subscriptions(customer_id)
        current = _list_current_subscriptions(customer_id)
    if not current:
        raise HTTPException(status_code=400, detail="No active subscription found")
    return current[0]


def _load_active_subscription(customer_id: str):
    return _load_current_subscription(customer_id)


def _invoice_preview(customer_id: str, sub_id: str, item_id: str, new_price_id: str):
    """Simulate the invoice for a price swap. Stripe renamed this API twice."""
    modern = dict(
        customer=customer_id,
        subscription=sub_id,
        subscription_details={
            "items": [{"id": item_id, "price": new_price_id}],
            "proration_behavior": "create_prorations",
        },
    )
    legacy = dict(
        customer=customer_id,
        subscription=sub_id,
        subscription_items=[{"id": item_id, "price": new_price_id}],
        subscription_proration_behavior="create_prorations",
    )
    errors: list[Exception] = []
    if hasattr(stripe.Invoice, "create_preview"):
        for params in (modern, legacy):
            try:
                return stripe.Invoice.create_preview(**params)  # type: ignore[attr-defined]
            except (TypeError, AttributeError, stripe.InvalidRequestError) as exc:
                errors.append(exc)
    if hasattr(stripe.Invoice, "upcoming"):
        try:
            return stripe.Invoice.upcoming(**legacy)  # type: ignore[attr-defined]
        except (TypeError, AttributeError, stripe.InvalidRequestError) as exc:
            errors.append(exc)
    logger.error("Invoice preview failed after fallbacks: %s", errors[-1] if errors else "no API")
    raise HTTPException(status_code=502, detail="Could not preview the plan change. Please try again.")


@router.post("/api/billing/checkout-session")
async def create_checkout_session(body: dict, user_id: str = Depends(require_auth)):
    """Create a Stripe Checkout Session for the selected pricing tier."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    tier = body.get("tier", "scholar")
    price_id = {
        "scholar": settings.stripe_price_scholar,
        "researcher": settings.stripe_price_researcher,
    }.get(tier)

    if not price_id:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {tier}")

    user = get_user(user_id)
    customer_id = (user or {}).get("stripe_customer_id")

    if not customer_id:
        customer = stripe.Customer.create(
            metadata={"clerk_user_id": user_id},
        )
        customer_id = customer.id
        update_user_stripe_customer(user_id, customer_id)

    if customer_id:
        existing = _list_current_subscriptions(customer_id)
        if existing:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "already_subscribed",
                    "message": "You already have an active subscription. Change plans from Settings instead of starting a new checkout.",
                },
            )

    success_url = body.get("success_url", "http://localhost:3000/dashboard?upgraded=1")
    cancel_url = body.get("cancel_url", "http://localhost:3000/#pricing")

    if not is_safe_redirect_url(success_url) or not is_safe_redirect_url(cancel_url):
        logger.warning(
            "Rejected checkout redirect urls success=%s cancel=%s allowed=%s",
            success_url,
            cancel_url,
            sorted(redirect_hosts()),
        )
        raise HTTPException(status_code=400, detail="Invalid redirect URL")

    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        client_reference_id=user_id,
        metadata={"clerk_user_id": user_id, "tier": tier},
        subscription_data={"metadata": {"clerk_user_id": user_id, "tier": tier}},
    )

    return {"url": session.url, "session_id": session.id}


@router.post("/api/billing/portal-session")
async def create_portal_session(body: dict, user_id: str = Depends(require_auth)):
    """Create a Stripe Customer Portal session for managing subscriptions."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    user = get_user(user_id)
    customer_id = (user or {}).get("stripe_customer_id")

    if not customer_id:
        raise HTTPException(status_code=400, detail="No Stripe customer on record. Subscribe first.")

    return_url = body.get("return_url", "http://localhost:3000/settings")
    if not is_safe_redirect_url(return_url):
        raise HTTPException(status_code=400, detail="Invalid redirect URL")

    session = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=return_url,
    )

    return {"url": session.url}


@router.post("/api/billing/cancel-subscription")
async def cancel_subscription(body: dict, user_id: str = Depends(require_auth)):
    """Cancel the user's subscription at period end, recording the reason."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    user = get_user(user_id)
    customer_id = (user or {}).get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription found")

    reason = (body.get("reason") or "")[:MAX_CANCEL_REASON]
    feedback = (body.get("feedback") or "")[:MAX_CANCEL_FEEDBACK]

    try:
        sub = _load_current_subscription(customer_id)
        updated = stripe.Subscription.modify(
            sub.id,
            cancel_at_period_end=True,
            metadata={
                "cancel_reason": reason[:MAX_CANCEL_REASON],
                "cancel_feedback": feedback[:MAX_CANCEL_FEEDBACK],
            },
        )

        period_end = None
        try:
            period_end = _stripe_period_end(updated)
        except Exception:
            pass

        store_cancellation_feedback(user_id, reason, feedback)

        logger.info("User %s scheduled cancellation: reason=%s", user_id, reason)
        return {
            "status": "scheduled",
            "cancel_at": period_end,
            "message": "Your subscription will remain active until the end of your billing period.",
        }
    except stripe.StripeError as e:
        # Stripe is an upstream dependency — surface its errors as 502 (bad
        # gateway) so infra dashboards can distinguish "our code broke" from
        # "Stripe is having a bad day". 500 used to lump the two together.
        logger.error("Cancel subscription failed: %s", e)
        raise HTTPException(status_code=502, detail="Failed to cancel subscription. Please try again.")


@router.post("/api/billing/resubscribe")
async def resubscribe(user_id: str = Depends(require_auth)):
    """Undo a pending cancellation by clearing cancel_at_period_end."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    user = get_user(user_id)
    customer_id = (user or {}).get("stripe_customer_id")
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription found")

    try:
        sub = _load_current_subscription(customer_id)
        stripe.Subscription.modify(sub.id, cancel_at_period_end=False)

        logger.info("User %s resubscribed (cleared cancel_at_period_end)", user_id)
        return {"status": "resubscribed", "message": "Your subscription has been renewed."}
    except stripe.StripeError as e:
        logger.error("Resubscribe failed: %s", e)
        raise HTTPException(status_code=502, detail="Failed to resubscribe. Please try again.")


def _resolve_tier_price(tier: str) -> str | None:
    return {
        "scholar": settings.stripe_price_scholar,
        "researcher": settings.stripe_price_researcher,
    }.get(tier)


def _stripe_period_end(sub) -> int | None:
    """Extract current_period_end from either a subscription object or the
    first subscription item (Stripe moved the field in later API versions)."""
    try:
        val = getattr(sub, "current_period_end", None)
        if val:
            return int(val)
    except Exception:
        pass
    try:
        if isinstance(sub, dict):
            val = sub.get("current_period_end")
            if val:
                return int(val)
    except Exception:
        pass
    try:
        item = sub["items"]["data"][0]
        val = getattr(item, "current_period_end", None)
        if val is None and isinstance(item, dict):
            val = item.get("current_period_end")
        return int(val) if val else None
    except Exception:
        return None


def _schedule_phase_start(schedule, sub) -> int | None:
    phase = getattr(schedule, "current_phase", None)
    start = None
    if phase is not None:
        start = getattr(phase, "start_date", None)
        if start is None and isinstance(phase, dict):
            start = phase.get("start_date")
    if start:
        return int(start)
    start = getattr(sub, "start_date", None)
    if start is None and isinstance(sub, dict):
        start = sub.get("start_date")
    return int(start) if start else None


def _assert_paid_plan_change(current_tier: str, target_tier: str) -> None:
    if target_tier not in ("scholar", "researcher"):
        raise HTTPException(status_code=400, detail=f"Unknown tier: {target_tier}")
    if current_tier == target_tier:
        raise HTTPException(status_code=400, detail="Already on this plan")
    if current_tier == "free":
        raise HTTPException(
            status_code=400,
            detail="No active subscription. Please subscribe first.",
        )


@router.post("/api/billing/upgrade-preview")
async def upgrade_preview(body: dict, user_id: str = Depends(require_auth)):
    """Return the prorated immediate charge and the next-cycle charge for
    a paid-plan change (upgrade or downgrade).
    """
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    target_tier = body.get("tier", "researcher")
    new_price_id = _resolve_tier_price(target_tier)
    if not new_price_id:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {target_tier}")

    user = get_user(user_id)
    current_tier = (user or {}).get("tier", "free")
    customer_id = (user or {}).get("stripe_customer_id")
    _assert_paid_plan_change(current_tier, target_tier)
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription. Please subscribe first.")

    try:
        sub = _load_current_subscription(customer_id)
        item_id = sub["items"]["data"][0].id
        current_price_id = sub["items"]["data"][0]["price"]["id"]
        preview = _invoice_preview(customer_id, sub.id, item_id, new_price_id)

        amount_due = int(getattr(preview, "amount_due", 0) or 0)
        currency = (getattr(preview, "currency", "usd") or "usd").lower()

        new_price = stripe.Price.retrieve(new_price_id)
        unit_amount = int(getattr(new_price, "unit_amount", 0) or 0)

        period_end = _stripe_period_end(sub)
        direction = (
            "upgrade"
            if TIER_ORDER.get(target_tier, 0) > TIER_ORDER.get(current_tier, 0)
            else "downgrade"
        )

        return {
            "currency": currency,
            "immediate_charge_cents": amount_due,
            "next_cycle_charge_cents": unit_amount,
            "period_end": period_end,
            "current_tier": current_tier,
            "target_tier": target_tier,
            "direction": direction,
            "current_price_id": current_price_id,
            "new_price_id": new_price_id,
        }
    except HTTPException:
        raise
    except stripe.StripeError as e:
        logger.error("Plan-change preview failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not preview the plan change. Please try again.")


@router.post("/api/billing/upgrade")
async def upgrade_subscription(body: dict, user_id: str = Depends(require_auth)):
    """Apply a paid-plan change (Scholar ↔ Researcher).

    ``when`` controls timing:
      - ``"now"`` (default): switch immediately with Stripe proration.
      - ``"next_cycle"``: keep the current price through period end, then
        swap via a SubscriptionSchedule. The app tier flips on webhook.
    """
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    target_tier = body.get("tier", "researcher")
    when = (body.get("when") or "now").lower()
    if when not in {"now", "next_cycle"}:
        raise HTTPException(status_code=400, detail="Invalid 'when' (must be 'now' or 'next_cycle')")

    new_price_id = _resolve_tier_price(target_tier)
    if not new_price_id:
        raise HTTPException(status_code=400, detail=f"Unknown tier: {target_tier}")

    user = get_user(user_id)
    current_tier = (user or {}).get("tier", "free")
    customer_id = (user or {}).get("stripe_customer_id")
    _assert_paid_plan_change(current_tier, target_tier)
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription. Please subscribe first.")

    try:
        sub = _load_current_subscription(customer_id)
        item_id = sub["items"]["data"][0].id
        current_price_id = sub["items"]["data"][0]["price"]["id"]
        period_end = _stripe_period_end(sub)

        if sub.cancel_at_period_end:
            stripe.Subscription.modify(sub.id, cancel_at_period_end=False)

        if when == "now":
            stripe.Subscription.modify(
                sub.id,
                items=[{"id": item_id, "price": new_price_id}],
                proration_behavior="create_prorations",
            )
            update_user_tier(user_id, target_tier)
            logger.info(
                "User %s changed plan %s → %s (prorated, immediate)",
                user_id, current_tier, target_tier,
            )
            return {
                "status": "upgraded",
                "tier": target_tier,
                "effective_at": "now",
            }

        if not period_end:
            raise HTTPException(
                status_code=502,
                detail="Could not determine current billing period end.",
            )

        schedule = stripe.SubscriptionSchedule.create(from_subscription=sub.id)
        start_date = _schedule_phase_start(schedule, sub)
        if not start_date:
            raise HTTPException(
                status_code=502,
                detail="Could not determine the current billing period start.",
            )
        stripe.SubscriptionSchedule.modify(
            schedule.id,
            end_behavior="release",
            phases=[
                {
                    "items": [{"price": current_price_id, "quantity": 1}],
                    "start_date": start_date,
                    "end_date": period_end,
                    "proration_behavior": "none",
                },
                {
                    "items": [{"price": new_price_id, "quantity": 1}],
                    "iterations": 1,
                },
            ],
        )

        logger.info(
            "User %s scheduled plan change %s → %s at %s",
            user_id, current_tier, target_tier, period_end,
        )
        return {
            "status": "scheduled",
            "tier": target_tier,
            "effective_at": period_end,
            "scheduled_for": period_end,
        }
    except HTTPException:
        raise
    except stripe.StripeError as e:
        logger.error("Plan change failed: %s", e)
        raise HTTPException(status_code=502, detail="Failed to change subscription. Please try again.")


def _to_dict(obj) -> dict:
    """Safely convert a Stripe object or dict to a plain dict."""
    if isinstance(obj, dict):
        return obj
    try:
        return dict(obj)
    except Exception:
        pass
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    return {}


@router.post("/api/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events (no auth — verified by signature).

    Stripe retries deliveries on timeout / 5xx, so this endpoint must be
    idempotent. We dedupe by ``event.id`` against the
    ``processed_stripe_events`` table (migration 009): a replay returns 200
    without re-running side effects. This prevents scenarios like
    ``customer.subscription.deleted`` running twice and double-downgrading
    a user who re-subscribed in the gap between the two deliveries.
    """
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        if not settings.stripe_webhook_secret:
            logger.error("Webhook secret not configured — rejecting event")
            raise HTTPException(status_code=503, detail="Webhook verification not configured")
        event = stripe.Webhook.construct_event(payload, sig_header, settings.stripe_webhook_secret)
    except stripe.SignatureVerificationError:
        logger.error("Webhook signature verification failed")
        raise HTTPException(status_code=400, detail="Invalid signature")
    except Exception as e:
        logger.error("Webhook parse error: %s", e.__class__.__name__)
        raise HTTPException(status_code=400, detail="Webhook processing error")

    event_type = event.get("type", "") if isinstance(event, dict) else getattr(event, "type", "")
    event_id = event.get("id", "") if isinstance(event, dict) else getattr(event, "id", "")

    if event_id and is_stripe_event_processed(event_id):
        logger.info("Skipping duplicate Stripe event %s (%s)", event_id, event_type)
        return {"status": "ok", "duplicate": True}

    if isinstance(event, dict):
        event_data_obj = event.get("data", {}).get("object", {})
    else:
        event_data_obj = _to_dict(event.data.object)

    try:
        if event_type == "checkout.session.completed":
            _handle_checkout_completed(event_data_obj)
        elif event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
            _handle_subscription_change(event_data_obj, event_type)
        elif event_type == "invoice.payment_failed":
            # Observability only — see note in `_handle_subscription_change`
            # about why we don't downgrade here.
            logger.warning(
                "Payment failed: customer=%s, attempt=%s",
                event_data_obj.get("customer"),
                event_data_obj.get("attempt_count"),
            )
        else:
            logger.info("Unhandled webhook event type: %s", event_type)
    except Exception:
        # Don't record the event as processed if handling failed: we want
        # Stripe's retry to try again. Log and re-raise so the HTTP
        # response is 500 (Stripe will retry on 5xx).
        logger.exception("Stripe webhook handler failed for %s", event_type)
        raise

    if event_id:
        try:
            mark_stripe_event_processed(event_id, event_type)
        except StripeDedupError:
            logger.error(
                "Cannot record Stripe event %s as processed — dedup unavailable",
                event_id,
            )
            raise HTTPException(
                status_code=503,
                detail="Webhook deduplication temporarily unavailable",
            )

    return {"status": "ok"}


def _handle_checkout_completed(session: dict):
    """Update user tier after successful checkout."""
    customer_id = session.get("customer", "")
    metadata = session.get("metadata") or {}
    clerk_user_id = metadata.get("clerk_user_id", "")
    tier = metadata.get("tier", "scholar")

    logger.info("_handle_checkout_completed: clerk_user_id=%s, tier=%s, customer=%s", clerk_user_id, tier, customer_id)

    if clerk_user_id:
        get_or_create_user(clerk_user_id)
        update_user_tier(clerk_user_id, tier)
        if customer_id:
            update_user_stripe_customer(clerk_user_id, customer_id)
            prefer = _resolve_tier_price(tier)
            try:
                dedupe_customer_subscriptions(customer_id, prefer_price_id=prefer)
            except stripe.StripeError:
                logger.exception("Dedupe after checkout failed for %s", customer_id)
        logger.info("User %s upgraded to %s", clerk_user_id, tier)
    elif customer_id:
        user = get_user_by_stripe_customer(customer_id)
        if user:
            update_user_tier(user["user_id"], tier)
            logger.info("User %s (by customer) upgraded to %s", user["user_id"], tier)
        else:
            logger.warning("No user found for customer %s", customer_id)
    else:
        logger.warning("Checkout completed but no user_id or customer_id found in metadata")


def _handle_subscription_change(subscription: dict, event_type: str):
    """Handle subscription updates or cancellations.

    When a user cancels, Stripe keeps status='active' with
    cancel_at_period_end=true until the billing period ends.
    Only customer.subscription.deleted fires when access should actually stop.
    """
    customer_id = subscription.get("customer", "")
    if not customer_id:
        return

    user = get_user_by_stripe_customer(customer_id)
    if not user:
        logger.warning("Subscription change for unknown customer: %s", customer_id)
        return

    try:
        dedupe_customer_subscriptions(customer_id)
    except stripe.StripeError:
        logger.exception("Dedupe on subscription change failed for %s", customer_id)

    remaining = _list_current_subscriptions(customer_id)
    remaining_tier = None
    if remaining:
        keep = max(
            remaining,
            key=lambda s: TIER_ORDER.get(PRICE_TO_TIER.get(_sub_price_id(s), "free"), 0),
        )
        remaining_tier = PRICE_TO_TIER.get(_sub_price_id(keep))

    if event_type == "customer.subscription.deleted":
        if remaining_tier:
            update_user_tier(user["user_id"], remaining_tier)
            logger.info(
                "User %s kept %s after a subscription was deleted (another is still live)",
                user["user_id"], remaining_tier,
            )
            return
        update_user_tier(user["user_id"], "free")
        logger.info("User %s downgraded to free (subscription deleted)", user["user_id"])
        return

    status = subscription.get("status", "")
    items = subscription.get("items", {}).get("data", [])
    price_id = items[0].get("price", {}).get("id", "") if items else ""
    resolved_tier = PRICE_TO_TIER.get(price_id)

    logger.info(
        "Subscription update: status=%s, price=%s, resolved_tier=%s, PRICE_TO_TIER=%s",
        status, price_id, resolved_tier, PRICE_TO_TIER,
    )

    if remaining_tier:
        # Live subscription is the source of truth — never apply this
        # event's price if it belongs to an orphan we just cancelled.
        if remaining_tier != resolved_tier:
            logger.info(
                "Subscription event price %s ignored; live sub is %s for user %s",
                resolved_tier, remaining_tier, user["user_id"],
            )
        update_user_tier(user["user_id"], remaining_tier)
        logger.info("User %s tier set to %s", user["user_id"], remaining_tier)
        return

    if status in ("active", "trialing"):
        if resolved_tier is None:
            logger.error(
                "Unknown Stripe price %s for user %s — keeping current tier %s "
                "(fix STRIPE_PRICE_SCHOLAR/STRIPE_PRICE_RESEARCHER env vars)",
                price_id, user["user_id"], user.get("tier"),
            )
            return
        update_user_tier(user["user_id"], resolved_tier)
        logger.info("User %s tier set to %s", user["user_id"], resolved_tier)
    elif status in ("unpaid", "past_due", "incomplete"):
        logger.warning(
            "User %s subscription in %s state — keeping tier until final cancellation",
            user["user_id"], status,
        )
    elif status == "canceled":
        update_user_tier(user["user_id"], "free")
        logger.info("User %s downgraded to free (status=canceled)", user["user_id"])


_feedback_rate: dict[str, float] = {}

@router.post("/api/feedback")
async def submit_feedback(body: dict, user_id: str = Depends(require_auth)):
    """Store general product feedback from authenticated users."""
    import time
    now = time.time()
    last = _feedback_rate.get(user_id, 0)
    if now - last < 10:
        raise HTTPException(status_code=429, detail="Please wait before submitting more feedback.")
    _feedback_rate[user_id] = now
    if len(_feedback_rate) > 10000:
        cutoff = now - 60
        stale = [k for k, v in _feedback_rate.items() if v < cutoff]
        for k in stale:
            del _feedback_rate[k]
    message = body.get("message", "").strip()[:5000]
    if not message:
        raise HTTPException(status_code=400, detail="Feedback message is required")
    store_feedback(user_id, message)
    return {"status": "ok"}
