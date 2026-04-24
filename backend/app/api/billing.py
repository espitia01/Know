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
)

MAX_CANCEL_REASON = 200
MAX_CANCEL_FEEDBACK = 2000
MAX_FEEDBACK_MESSAGE = 5000

logger = logging.getLogger(__name__)

router = APIRouter(tags=["billing"])

PRICE_TO_TIER: dict[str, str] = {}


def _init_stripe():
    if settings.stripe_secret_key:
        stripe.api_key = settings.stripe_secret_key
    if settings.stripe_price_scholar:
        PRICE_TO_TIER[settings.stripe_price_scholar] = "scholar"
    if settings.stripe_price_researcher:
        PRICE_TO_TIER[settings.stripe_price_researcher] = "researcher"
    logger.info("Stripe init: PRICE_TO_TIER=%s", PRICE_TO_TIER)


_init_stripe()


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

    success_url = body.get("success_url", "http://localhost:3000/dashboard?upgraded=1")
    cancel_url = body.get("cancel_url", "http://localhost:3000/#pricing")

    allowed_hosts = {"localhost:3000"}
    extra = os.environ.get("KNOW_CORS_ORIGINS", "")
    if extra:
        for origin in extra.split(","):
            origin = origin.strip()
            if origin:
                try:
                    from urllib.parse import urlparse
                    allowed_hosts.add(urlparse(origin).netloc)
                except Exception:
                    pass

    def _is_safe_url(url: str) -> bool:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return parsed.scheme in ("http", "https") and parsed.netloc in allowed_hosts

    if not _is_safe_url(success_url) or not _is_safe_url(cancel_url):
        raise HTTPException(status_code=400, detail="Invalid redirect URL")

    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"clerk_user_id": user_id, "tier": tier},
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

    from urllib.parse import urlparse
    allowed_hosts = {"localhost:3000"}
    extra = os.environ.get("KNOW_CORS_ORIGINS", "")
    if extra:
        for origin in extra.split(","):
            origin = origin.strip()
            if origin:
                try:
                    allowed_hosts.add(urlparse(origin).netloc)
                except Exception:
                    pass

    parsed = urlparse(return_url)
    if not (parsed.scheme in ("http", "https") and parsed.netloc in allowed_hosts):
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
        subs = stripe.Subscription.list(customer=customer_id, status="active", limit=1)
        if not subs.data:
            raise HTTPException(status_code=400, detail="No active subscription found")

        sub = subs.data[0]
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
            period_end = updated.current_period_end
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
        subs = stripe.Subscription.list(customer=customer_id, status="active", limit=1)
        if not subs.data:
            raise HTTPException(status_code=400, detail="No active subscription found")

        sub = subs.data[0]
        stripe.Subscription.modify(sub.id, cancel_at_period_end=False)

        logger.info("User %s resubscribed (cleared cancel_at_period_end)", user_id)
        return {"status": "resubscribed", "message": "Your subscription has been renewed."}
    except stripe.StripeError as e:
        logger.error("Resubscribe failed: %s", e)
        raise HTTPException(status_code=502, detail="Failed to resubscribe. Please try again.")


TIER_ORDER = {"free": 0, "scholar": 1, "researcher": 2}


def _resolve_tier_price(tier: str) -> str | None:
    return {
        "scholar": settings.stripe_price_scholar,
        "researcher": settings.stripe_price_researcher,
    }.get(tier)


def _load_active_subscription(customer_id: str):
    """Fetch the customer's active subscription or raise HTTPException."""
    subs = stripe.Subscription.list(customer=customer_id, status="active", limit=1)
    if not subs.data:
        raise HTTPException(status_code=400, detail="No active subscription found")
    return subs.data[0]


def _stripe_period_end(sub) -> int | None:
    """Extract current_period_end from either a subscription object or the
    first subscription item (Stripe moved the field in 2023 API versions)."""
    try:
        val = getattr(sub, "current_period_end", None)
        if val:
            return int(val)
    except Exception:
        pass
    try:
        item = sub["items"]["data"][0]
        val = getattr(item, "current_period_end", None) or item.get("current_period_end")
        return int(val) if val else None
    except Exception:
        return None


@router.post("/api/billing/upgrade-preview")
async def upgrade_preview(body: dict, user_id: str = Depends(require_auth)):
    """Return the prorated immediate charge and the next-cycle charge for
    a tier change, so the client can ask the user to choose between
    "upgrade now" and "upgrade at next renewal".

    The preview does **not** modify the subscription — we call
    ``Invoice.create_preview`` with the proposed item change and read back
    ``amount_due``. The next-cycle amount is just the new price.
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

    if TIER_ORDER.get(target_tier, 0) <= TIER_ORDER.get(current_tier, 0):
        raise HTTPException(status_code=400, detail="Already on this tier or higher")
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription. Please subscribe first.")

    try:
        sub = _load_active_subscription(customer_id)
        item_id = sub["items"]["data"][0].id
        current_price_id = sub["items"]["data"][0]["price"]["id"]

        # Ask Stripe to *simulate* the invoice that would be generated if
        # we swapped to the new price right now. We don't commit the
        # change — this call is side-effect free. Older Stripe SDKs
        # expose this as `Invoice.upcoming`; newer ones as
        # `Invoice.create_preview`. Try both so deploys on either API
        # version keep working.
        params = dict(
            customer=customer_id,
            subscription=sub.id,
            subscription_items=[{"id": item_id, "price": new_price_id}],
            subscription_proration_behavior="create_prorations",
        )
        try:
            preview = stripe.Invoice.create_preview(**params)  # type: ignore[attr-defined]
        except (AttributeError, stripe.InvalidRequestError):
            preview = stripe.Invoice.upcoming(**params)  # type: ignore[attr-defined]

        amount_due = int(getattr(preview, "amount_due", 0) or 0)
        currency = (getattr(preview, "currency", "usd") or "usd").lower()

        # Monthly price for the target tier — read from Stripe so we
        # don't hardcode prices anywhere in the app.
        new_price = stripe.Price.retrieve(new_price_id)
        unit_amount = int(getattr(new_price, "unit_amount", 0) or 0)

        period_end = _stripe_period_end(sub)

        return {
            "currency": currency,
            "immediate_charge_cents": max(0, amount_due),
            "next_cycle_charge_cents": unit_amount,
            "period_end": period_end,
            "current_tier": current_tier,
            "target_tier": target_tier,
            "current_price_id": current_price_id,
            "new_price_id": new_price_id,
        }
    except stripe.StripeError as e:
        logger.error("Upgrade preview failed: %s", e)
        raise HTTPException(status_code=502, detail="Could not preview the upgrade. Please try again.")


@router.post("/api/billing/upgrade")
async def upgrade_subscription(body: dict, user_id: str = Depends(require_auth)):
    """Apply a tier upgrade.

    ``when`` controls timing:
      - ``"now"`` (default): switch immediately with Stripe proration.
        The user is charged the prorated difference today and tier flips
        in the app right away.
      - ``"next_cycle"``: keep the current price through the end of the
        existing billing period and swap to the new price at renewal.
        No charge today, and the app tier does **not** change until the
        webhook fires on the next renewal. Implemented with a
        ``SubscriptionSchedule`` so Stripe owns the transition.
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

    if TIER_ORDER.get(target_tier, 0) <= TIER_ORDER.get(current_tier, 0):
        raise HTTPException(status_code=400, detail="Already on this tier or higher")
    if not customer_id:
        raise HTTPException(status_code=400, detail="No active subscription. Please subscribe first.")

    try:
        sub = _load_active_subscription(customer_id)
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
                "User %s upgraded from %s to %s (prorated, immediate)",
                user_id, current_tier, target_tier,
            )
            return {
                "status": "upgraded",
                "tier": target_tier,
                "effective_at": "now",
            }

        # when == "next_cycle"
        # We promote the live subscription into a schedule and append a
        # second phase that starts at period end with the new price.
        # Stripe handles the transition without any further action from
        # us; the `customer.subscription.updated` webhook will fire on
        # renewal and our handler will flip the user's tier then.
        if not period_end:
            raise HTTPException(
                status_code=502,
                detail="Could not determine current billing period end.",
            )

        schedule = stripe.SubscriptionSchedule.create(from_subscription=sub.id)
        stripe.SubscriptionSchedule.modify(
            schedule.id,
            end_behavior="release",
            phases=[
                {
                    "items": [{"price": current_price_id, "quantity": 1}],
                    "start_date": (
                        getattr(schedule, "current_phase", {}).get("start_date")
                        if hasattr(schedule, "current_phase") and schedule.current_phase
                        else None
                    ) or int(getattr(sub, "start_date", 0) or 0) or None,
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
            "User %s scheduled upgrade %s → %s at %s",
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
        logger.error("Upgrade subscription failed: %s", e)
        raise HTTPException(status_code=502, detail="Failed to upgrade subscription. Please try again.")


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
        mark_stripe_event_processed(event_id, event_type)

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

    if event_type == "customer.subscription.deleted":
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

    if status in ("active", "trialing"):
        if resolved_tier is None:
            # Unknown price id → this is almost always a misconfigured
            # Stripe env var on our side, not "this user should be free".
            # Defaulting to free would silently downgrade a paying customer
            # on every webhook tick. Keep their current tier and alert.
            logger.error(
                "Unknown Stripe price %s for user %s — keeping current tier %s "
                "(fix STRIPE_PRICE_SCHOLAR/STRIPE_PRICE_RESEARCHER env vars)",
                price_id, user["user_id"], user.get("tier"),
            )
            return
        update_user_tier(user["user_id"], resolved_tier)
        logger.info("User %s tier set to %s", user["user_id"], resolved_tier)
    elif status in ("unpaid", "past_due", "incomplete"):
        # Dunning states: Stripe is still retrying the payment. Don't
        # downgrade yet — doing so would punish users for a transient
        # failure (expired card, bank outage, manual review, etc.) and they
        # couldn't use the product while we waited for the retry. The
        # downgrade happens on `customer.subscription.deleted` once Stripe
        # gives up, typically 3 retries / ~2 weeks later.
        logger.warning(
            "User %s subscription in %s state — keeping tier until final cancellation",
            user["user_id"], status,
        )
    elif status == "canceled":
        # Final cancellation via the portal / `subscription.deleted` often
        # arrives as `status=canceled` on `subscription.updated` too.
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
