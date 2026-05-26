"""Authentication dependencies."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError

from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from .config import settings

logger = logging.getLogger(__name__)

bearer_scheme = HTTPBearer(auto_error=False)

_jwks_client: PyJWKClient | None = None
_jwks_lock = threading.Lock()


def _is_production() -> bool:
    return bool(
        os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("KNOW_PRODUCTION")
    )


def _get_jwks_client() -> PyJWKClient | None:
    global _jwks_client
    if _jwks_client is not None:
        return _jwks_client
    if settings.clerk_jwks_url:
        _jwks_client = PyJWKClient(
            settings.clerk_jwks_url,
            cache_keys=True,
            cache_jwk_set=True,
            lifespan=3600,
            timeout=30,
        )
        return _jwks_client
    return None


def _fetch_signing_key(token: str):
    """Resolve the Clerk signing key for ``token`` (sync, guarded)."""
    jwks = _get_jwks_client()
    if not jwks:
        return None
    with _jwks_lock:
        return jwks.get_signing_key_from_jwt(token)


def warm_jwks_cache() -> bool:
    """Prefetch Clerk JWKS at startup. Returns True when reachable."""
    jwks = _get_jwks_client()
    if not jwks:
        logger.critical("KNOW_CLERK_JWKS_URL unset — auth will fail closed")
        return False
    try:
        with _jwks_lock:
            jwks.get_jwk_set()
        logger.info("Clerk JWKS cache warmed from %s", settings.clerk_jwks_url)
        return True
    except PyJWKClientError as e:
        logger.error("Clerk JWKS warmup failed for %s: %s", settings.clerk_jwks_url, e)
        return False
    except Exception:
        logger.exception("Clerk JWKS warmup failed for %s", settings.clerk_jwks_url)
        return False


def jwks_status() -> tuple[bool, str]:
    """Return (ok, detail) for health checks."""
    if not settings.clerk_jwks_url:
        return False, "KNOW_CLERK_JWKS_URL not set"
    try:
        warm_jwks_cache()
        return True, "ok"
    except Exception as e:
        return False, str(e)


async def require_auth(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> str:
    """Validate the Clerk JWT and return the user_id (sub claim).

    Error classification:
        * 401 — token missing, expired, or cryptographically invalid.
        * 503 — our auth dependencies are unreachable or misconfigured (no
          JWKS, JWKS fetch failed, required audience missing in prod). 500
          for these hides a fixable infra issue behind a generic error.
    """
    if not creds:
        raise HTTPException(status_code=401, detail="Unauthorized")

    token = creds.credentials
    jwks = _get_jwks_client()

    if not jwks:
        logger.critical("JWKS not configured — rejecting all authenticated requests")
        raise HTTPException(status_code=503, detail="Authentication not configured")

    # In production we require the token to be bound to *something*: either
    # an audience (preferred — defends against cross-API token replay inside
    # the same Clerk org) or at minimum an issuer (binds the token to our
    # Clerk instance). If neither is configured, we're verifying signatures
    # on effectively anonymous JWTs — fail closed.
    if _is_production() and not settings.clerk_audience and not settings.clerk_issuer:
        logger.critical(
            "KNOW_CLERK_AUDIENCE and KNOW_CLERK_ISSUER are both unset in "
            "production — rejecting all requests until one is configured"
        )
        raise HTTPException(status_code=503, detail="Authentication not configured")

    if _is_production() and not settings.clerk_audience:
        # Not fatal (issuer still binds the token to our Clerk instance), but
        # audience binding is strictly stronger. Log once per request so it
        # shows up in triage dashboards until it's set.
        logger.warning(
            "KNOW_CLERK_AUDIENCE unset in production — falling back to "
            "issuer-only validation. Configure a Clerk JWT template audience "
            "for defense-in-depth."
        )

    try:
        signing_key = None
        last_jwks_error: PyJWKClientError | None = None
        for attempt in range(2):
            try:
                # Keep JWKS on the event-loop thread — PyJWKClient reuses a
                # urllib3 pool that misbehaves when called from thread workers.
                signing_key = _fetch_signing_key(token)
                break
            except PyJWKClientError as e:
                last_jwks_error = e
                if attempt == 0:
                    await asyncio.sleep(0.25)
                    continue
        if signing_key is None:
            logger.warning("JWKS signing key fetch failed: %s", last_jwks_error)
            raise HTTPException(
                status_code=503, detail="Authentication service unavailable",
            )

        decode_opts: dict = {"algorithms": ["RS256"]}
        if settings.clerk_issuer:
            decode_opts["issuer"] = settings.clerk_issuer

        jwt_options: dict = {}
        if settings.clerk_audience:
            decode_opts["audience"] = settings.clerk_audience
        else:
            jwt_options["verify_aud"] = False
            logger.warning("KNOW_CLERK_AUDIENCE is not set — audience validation disabled")

        payload = jwt.decode(
            token,
            signing_key.key,
            **decode_opts,
            options=jwt_options,
        )
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Token missing user identity")
        from .services.db import get_or_create_user

        email = payload.get("email") or ""
        try:
            await asyncio.to_thread(get_or_create_user, user_id, email)
        except Exception as e:
            # JWT is already verified — don't fail the whole request when
            # Supabase is slow; /api/user/me will retry user bootstrap.
            logger.warning("get_or_create_user failed for %s: %s", user_id, e)
        return user_id
    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as e:
        # Unknown failure in the auth path — surface as 503 (service issue,
        # retryable) rather than 500. A blanket 500 conflated token issues
        # with our own bugs and made production triage harder.
        logger.exception("Unexpected auth error: %s", e)
        raise HTTPException(status_code=503, detail="Authentication failed")
