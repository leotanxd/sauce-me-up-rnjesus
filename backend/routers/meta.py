"""Health check, metrics, and the JSON-404 catch-all for unmatched
/api/* paths."""

import time
from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException


def build_health(
    last_success_at: float | None,
    fresh_seconds: float,
    now: float | None = None,
    cooldown_until: float | None = None,
) -> dict:
    """The /api/health body: app status plus observed upstream contact.

    ``status`` is always "ok" and the endpoint always answers 200 —
    upstream state is information, never app death. upstreamStatus is
    "ok" (a success within the freshness window), "stale" (a success
    exists but is older), or "unknown" (no upstream call has succeeded
    since process start; lastSuccessAt is then null).

    ``cooldown_until`` (wall clock) is informational: while the
    shared upstream cooldown is active it is reported as
    upstream.cooldownUntil; the key is absent otherwise, so the
    body's shape is unchanged in normal operation.
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
    upstream = {
        "lastSuccessAt": stamp,
        "upstreamStatus": upstream_status,
    }
    if cooldown_until is not None:
        upstream["cooldownUntil"] = datetime.fromtimestamp(
            cooldown_until, timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "status": "ok",
        "upstream": upstream,
    }


def create_meta_router(
    health_provider: Callable[[], dict] | None = None,
    metrics_provider: Callable[[], dict] | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    async def health() -> dict:
        # Async on purpose (Package 4): the handler only reads
        # observed state, so it answers on the event loop even while
        # every threadpool thread is busy with long batch work —
        # a sync handler would queue behind exactly the load a
        # health check exists to observe.
        if health_provider is not None:
            return health_provider()
        return {"status": "ok"}

    if metrics_provider is not None:
        # Registered only when a metrics registry is wired in
        # (Settings.metrics_enabled); otherwise the path falls
        # through to the JSON 404 below like any unknown route.

        @router.get("/api/metrics")
        def metrics() -> dict:
            return metrics_provider()

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
