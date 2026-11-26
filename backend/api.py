"""HTTP API for Sauce Me Up, RNJesus — composition root.

This module only wires things together: settings, the upstream
client, the state stores, and the picker service go into create_app(),
which builds the FastAPI app and includes the routers. The pieces
live in their own modules:

    backend/config.py          Settings (all tunables, one home)
    backend/stores.py          RecentServedStore, DetailCache
    backend/picker.py          SaucePicker (pick orchestration)
    backend/routers/sauce.py   /api/sauce/* routes (thin)
    backend/routers/meta.py    /api/health + JSON-404 catch-all
    backend/middleware.py      CacheHeadersMiddleware (cache policy)
    src/client.py              NhentaiClient (upstream facade)

Run:
    pip install -e .
    (installs this repo as a package — see pyproject.toml;
    requirements.txt is the hash-locked variant used by Docker/CI)
    uvicorn backend.api:app --reload --port 8000

Endpoints:
    GET /api/health          -> {"status": "ok"}
    GET /api/metrics         -> in-process counters (Package 4)
    GET /api/sauce/next      -> one random gallery, FIRST page image only
    GET /api/sauce/batch?n=3 -> n x /next (for pre-loading the feed)
    Both accept ?mode=popular to draw from the API's popular-week sort
    (currently very popular) instead of the default whole-catalogue
    random feed (?mode=random).
    GET /api/sauce/{id}/pages -> ALL page image URLs for one gallery,
                                 in order (explicit in-sauce browsing)
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from src.cdn import MediaUrlBuilder
from src.client import NhentaiClient
from src.http_client import JsonHttpClient
from src.metrics import Metrics
from src.pools import SearchPool

from .config import Settings
from .middleware import CacheHeadersMiddleware, RequestIdMiddleware
from .picker import SaucePicker
from .routers.meta import build_health, create_meta_router
from .routers.sauce import create_sauce_router
from .stores import DetailCache, RecentServedStore

logger = logging.getLogger(__name__)


def _run_warm_up(client: NhentaiClient, deadline_seconds: float) -> None:
    """Startup warm-up thread body (Package 4): prime the search
    pools + CDN config so the first visitor after a spin-down
    doesn't pay those fetches serially. Best-effort by design — a
    failure is logged once and never affects boot or requests; the
    pools refill lazily on demand exactly as before."""
    try:
        client.warm_up(deadline=time.monotonic() + deadline_seconds)
    except Exception as error:
        logger.warning("Startup warm-up failed: %s", error)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app with fresh stores and a fresh upstream client."""
    settings = settings if settings is not None else Settings()

    # Package 4: one metrics registry shared by every instrumented
    # layer (transport, pools, picker), served at /api/metrics.
    # Disabled -> None everywhere, and no endpoint is registered.
    metrics = Metrics() if settings.metrics_enabled else None

    # The transport carries the Package 2 protections (shared
    # 429/403 cooldown + global request budget), tuned from Settings.
    http = JsonHttpClient(
        cooldown_default_seconds=settings.upstream_cooldown_default_seconds,
        forbidden_cooldown_seconds=settings.upstream_forbidden_cooldown_seconds,
        budget_rate_per_minute=settings.global_budget_rate_per_minute,
        budget_burst=settings.global_budget_burst,
        metrics=metrics,
    )
    # Package 3 tunables ride along: the pools' background-refill
    # low-water mark and the CDN config refresh TTL.
    client = NhentaiClient(
        http=http,
        media=MediaUrlBuilder(http, config_ttl_seconds=settings.cdn_config_ttl_seconds),
        pool=SearchPool(
            http,
            low_water_mark=settings.pool_low_water_mark,
            metrics=metrics,
        ),
    )
    picker = SaucePicker(
        client=client,
        recent=RecentServedStore(maxlen=settings.recent_max),
        details=DetailCache(
            ttl_seconds=settings.detail_ttl_seconds,
            max_entries=settings.detail_cache_max,
        ),
        settings=settings,
        metrics=metrics,
    )

    app = FastAPI(title="Sauce Me Up, RNJesus — API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    app.add_middleware(CacheHeadersMiddleware)
    # Outermost: the request ID exists before anything else runs,
    # so every log line under the request can carry it.
    app.add_middleware(RequestIdMiddleware)

    def health_provider() -> dict:
        # Observed upstream contact only — health never probes (a
        # probe would burn anonymous upstream quota). The cooldown
        # field appears only while a 429/403 cooldown is active.
        return build_health(
            client.upstream_last_success_at(),
            settings.health_fresh_seconds,
            cooldown_until=client.upstream_cooldown_until(),
        )

    # Real API routes first; the meta router's /api/{path} catch-all
    # (JSON 404) must be registered after them.
    app.include_router(create_sauce_router(picker))
    app.include_router(
        create_meta_router(
            health_provider,
            metrics_provider=metrics.snapshot if metrics is not None else None,
        )
    )

    # Startup warm-up (Package 4): fire-and-forget on a daemon
    # thread — create_app returns immediately whether or not the
    # upstream is reachable. The thread is kept on app.state so
    # tests (and only tests) can join it deterministically.
    warm_up_thread = threading.Thread(
        target=_run_warm_up,
        args=(client, settings.warm_up_deadline_seconds),
        name="startup-warm-up",
        daemon=True,
    )
    app.state.warm_up_thread = warm_up_thread
    warm_up_thread.start()

    # --- Single-service deployment (Render / Docker) -----------------
    # If the frontend has been built (frontend/dist exists, as in the
    # Docker image), serve it from this same app so ONE service = ONE
    # public URL. The /api routes above are registered first and take
    # precedence. In local dev without a build, this is skipped and
    # Vite serves the UI.
    frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if frontend_dist.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=frontend_dist, html=True),
            name="frontend",
        )

    return app


app = create_app()
