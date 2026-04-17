from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    app_name: str = "Know"
    papers_dir: Path = Path(__file__).resolve().parent.parent.parent / "papers"
    anthropic_api_key: str = ""
    local_model_url: str = ""
    local_model_name: str = ""
    active_provider: str = "anthropic"  # "anthropic" or "local"

    model_config = {"env_prefix": "KNOW_", "env_file": ".env"}


settings = Settings()
settings.papers_dir.mkdir(parents=True, exist_ok=True)
