"""Run blocking callables off the asyncio event loop."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


async def run_sync(func: Callable[..., T], /, *args, **kwargs) -> T:
    """Execute a sync function in the default thread pool."""
    return await asyncio.to_thread(func, *args, **kwargs)
