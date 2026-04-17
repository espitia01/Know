"""API routes for settings management."""

from __future__ import annotations

from fastapi import APIRouter

from ..config import settings
from ..models.schemas import SettingsResponse, SettingsUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=SettingsResponse)
async def get_settings():
    return SettingsResponse(
        has_anthropic_key=bool(settings.anthropic_api_key),
        local_model_url=settings.local_model_url,
        local_model_name=settings.local_model_name,
        active_provider=settings.active_provider,
    )


@router.put("", response_model=SettingsResponse)
async def update_settings(update: SettingsUpdate):
    if update.anthropic_api_key is not None:
        settings.anthropic_api_key = update.anthropic_api_key
    if update.local_model_url is not None:
        settings.local_model_url = update.local_model_url
    if update.local_model_name is not None:
        settings.local_model_name = update.local_model_name
    if update.active_provider is not None:
        settings.active_provider = update.active_provider

    return SettingsResponse(
        has_anthropic_key=bool(settings.anthropic_api_key),
        local_model_url=settings.local_model_url,
        local_model_name=settings.local_model_name,
        active_provider=settings.active_provider,
    )
