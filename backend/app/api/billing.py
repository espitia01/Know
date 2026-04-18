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
)

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

    reason = body.get("reason", "")
    feedback = body.get("feedback", "")

    try:
        subs = stripe.Subscription.list(customer=customer_id, status="active", limit=1)
        if not subs.data:
            raise HTTPException(status_code=400, detail="No active subscription found")

        sub = subs.data[0]
        updated = stripe.Subscription.modify(
            sub.id,
            cancel_at_period_end=True,
            metadata={
                "cancel_reason": reason,
                "cancel_feedback": feedback,
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
        logger.error("Cancel subscription failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to cancel subscription. Please try again.")


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
        raise HTTPException(status_code=500, detail="Failed to resubscribe. Please try again.")


TIER_ORDER = {"free": 0, "scholar": 1, "researcher": 2}


@router.post("/api/billing/upgrade")
async def upgrade_subscription(body: dict, user_id: str = Depends(require_auth)):
    """Upgrade an existing subscription using Stripe proration."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    target_tier = body.get("tier", "researcher")
    new_price_id = {
        "scholar": settings.stripe_price_scholar,
        "researcher": settings.stripe_price_researcher,
    }.get(target_tier)

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
        subs = stripe.Subscription.list(customer=customer_id, status="active", limit=1)
        if not subs.data:
            raise HTTPException(status_code=400, detail="No active subscription found")

        sub = subs.data[0]
        item_id = sub["items"]["data"][0].id

        if sub.cancel_at_period_end:
            stripe.Subscription.modify(sub.id, cancel_at_period_end=False)

        stripe.Subscription.modify(
            sub.id,
            items=[{"id": item_id, "price": new_price_id}],
            proration_behavior="create_prorations",
        )

        update_user_tier(user_id, target_tier)
        logger.info("User %s upgraded from %s to %s (prorated)", user_id, current_tier, target_tier)
        return {"status": "upgraded", "tier": target_tier}
    except stripe.StripeError as e:
        logger.error("Upgrade subscription failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to upgrade subscription. Please try again.")


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
    """Handle Stripe webhook events (no auth — verified by signature)."""
    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    logger.info("Webhook received: sig=%s..., payload_len=%d", sig_header[:30] if sig_header else "none", len(payload))

    try:
        if not settings.stripe_webhook_secret:
            logger.error("Webhook secret not configured — rejecting event")
            raise HTTPException(status_code=503, detail="Webhook verification not configured")
        event = stripe.Webhook.construct_event(payload, sig_header, settings.stripe_webhook_secret)
    except stripe.SignatureVerificationError:
        logger.error("Webhook signature verification failed")
        raise HTTPException(status_code=400, detail="Invalid signature")
    except Exception as e:
        logger.error("Webhook parse error: %s", e)
        raise HTTPException(status_code=400, detail="Webhook processing error")

    event_type = event.get("type", "") if isinstance(event, dict) else getattr(event, "type", "")
    logger.info("Webhook event type: %s", event_type)

    if isinstance(event, dict):
        event_data_obj = event.get("data", {}).get("object", {})
    else:
        event_data_obj = _to_dict(event.data.object)

    if event_type == "checkout.session.completed":
        logger.info("Checkout completed: %s", {k: event_data_obj.get(k) for k in ("customer", "metadata", "subscription")})
        _handle_checkout_completed(event_data_obj)

    elif event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
        logger.info("Subscription change: status=%s, customer=%s", event_data_obj.get("status"), event_data_obj.get("customer"))
        _handle_subscription_change(event_data_obj, event_type)
    else:
        logger.info("Unhandled webhook event type: %s", event_type)

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
    else:
        status = subscription.get("status", "")
        items = subscription.get("items", {}).get("data", [])
        price_id = items[0].get("price", {}).get("id", "") if items else ""
        new_tier = PRICE_TO_TIER.get(price_id, "free")

        logger.info("Subscription update: status=%s, price=%s, resolved_tier=%s, PRICE_TO_TIER=%s", status, price_id, new_tier, PRICE_TO_TIER)

        if status in ("active", "trialing"):
            update_user_tier(user["user_id"], new_tier)
            logger.info("User %s tier set to %s", user["user_id"], new_tier)
        elif status in ("unpaid", "past_due"):
            update_user_tier(user["user_id"], "free")


@router.post("/api/feedback")
async def submit_feedback(body: dict, user_id: str = Depends(require_auth)):
    """Store general product feedback from authenticated users."""
    message = body.get("message", "").strip()[:5000]
    if not message:
        raise HTTPException(status_code=400, detail="Feedback message is required")
    store_feedback(user_id, message)
    return {"status": "ok"}
