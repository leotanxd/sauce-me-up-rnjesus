"""Health check and the JSON-404 catch-all for unmatched /api/* paths."""

import time
from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException


def build_health(
    last_success_at: float | None,
    fresh_seconds: float,
    now: float | None = None,
) -> dict:
    """The /api/health body: app status plus observed upstream contact.

    ``status`` is always "ok" and the endpoint always answers 200 —
    upstream state is information, never app death. upstreamStatus is
    "ok" (a success within the freshness window), "stale" (a success
    exists but is older), or "unknown" (no upstream call has succeeded
    since process start; lastSuccessAt is then null).
    """
    now = time.time() if now is None else now
    if last_success_at is None:
        upstream_status, stamp = "unknown", None
    else:
        stamp = datetime.fromtimestamp(last_success_at, timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        upstream_status = (
            "ok" if now - last_success_at <= fresh_seconds else "stale"
        )
    return {
        "status": "ok",
        "upstream": {
            "lastSuccessAt": stamp,
            "upstreamStatus": upstream_status,
        },
    }


def create_meta_router(
    health_provider: Callable[[], dict] | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    def health() -> dict:
        if health_provider is not None:
            return health_provider()
        return {"status": "ok"}

    # Any /api/* path that matched no earlier route is a client bug —
    # answer with a JSON 404 instead of the SPA's index.html (which
    # the static mount would otherwise serve with a misleading 200).
    # This router must be included AFTER the real API routers.
    @router.api_route(
        "/api/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    )
    def api_not_found(path: str) -> dict:
        raise HTTPException(status_code=404, detail="Not found.")

    return router
