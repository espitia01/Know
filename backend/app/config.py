from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    app_name: str = "Know"
    papers_dir: Path = Path(__file__).resolve().parent.parent.parent / "papers"
    anthropic_api_key: str = ""
    analysis_model: str = "claude-sonnet-4-6"
    fast_model: str = "claude-haiku-4-5"

    # Clerk auth
    clerk_secret_key: str = ""
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
