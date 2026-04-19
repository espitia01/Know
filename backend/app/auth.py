"""Authentication dependencies."""

from __future__ import annotations

import logging
import os
import jwt
from jwt import PyJWKClient

from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from .config import settings

logger = logging.getLogger(__name__)

bearer_scheme = HTTPBearer(auto_error=False)

_jwks_client: PyJWKClient | None = None


def _get_jwks_client() -> PyJWKClient | None:
    global _jwks_client
    if _jwks_client is not None:
        return _jwks_client
    if settings.clerk_jwks_url:
        _jwks_client = PyJWKClient(settings.clerk_jwks_url)
        return _jwks_client
    return None


async def require_auth(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> str:
    """Validate the Clerk JWT and return the user_id (sub claim)."""
    if not creds:
        raise HTTPException(status_code=401, detail="Unauthorized")

    token = creds.credentials
    jwks = _get_jwks_client()

    if not jwks:
        logger.critical("JWKS not configured — rejecting all authenticated requests")
        raise HTTPException(status_code=503, detail="Authentication not configured")

    try:
        signing_key = jwks.get_signing_key_from_jwt(token)
        decode_opts: dict = {"algorithms": ["RS256"]}
        if settings.clerk_issuer:
            decode_opts["issuer"] = settings.clerk_issuer

        jwt_options: dict = {}
        if settings.clerk_audience:
            decode_opts["audience"] = settings.clerk_audience
        else:
            jwt_options["verify_aud"] = False
            if os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("KNOW_PRODUCTION"):
                logger.warning("KNOW_CLERK_AUDIENCE is not set in production — audience validation disabled")
            else:
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
        get_or_create_user(user_id, email=payload.get("email", ""))
        return user_id
    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    except Exception as e:
        logger.exception("Unexpected auth error: %s", e)
        raise HTTPException(status_code=500, detail="Authentication failed")
