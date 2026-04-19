from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    app_name: str = "Know"
    papers_dir: Path = Path(__file__).resolve().parent.parent.parent / "papers"
    anthropic_api_key: str = ""
    analysis_model: str = "claude-sonnet-4-6"
    fast_model: str = "claude-haiku-4-5"

    # Clerk auth
    clerk_jwks_url: str = ""
    clerk_issuer: str = ""
    clerk_audience: str = ""

    # Supabase
    supabase_url: str = ""
    supabase_key: str = ""

    # Stripe
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_scholar: str = ""
    stripe_price_researcher: str = ""

    # CORS (comma-separated production domains, never use *)
    cors_origins: str = ""

    model_config = {"env_prefix": "KNOW_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
settings.papers_dir.mkdir(parents=True, exist_ok=True)

import logging as _cfg_logging
_cfg_logger = _cfg_logging.getLogger("know.config")
if not settings.anthropic_api_key:
    _cfg_logger.warning("KNOW_ANTHROPIC_API_KEY not set — LLM features will fail")
if not settings.supabase_url or not settings.supabase_key:
    _cfg_logger.warning("Supabase not configured — persistence disabled, limits will fail closed")
if not settings.clerk_jwks_url:
    _cfg_logger.warning("KNOW_CLERK_JWKS_URL not set — authentication will reject all requests")
