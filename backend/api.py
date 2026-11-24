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
    pip install -r backend/requirements.txt
    uvicorn backend.api:app --reload --port 8000

Endpoints:
    GET /api/health          -> {"status": "ok"}
    GET /api/sauce/next      -> one random gallery, FIRST page image only
    GET /api/sauce/batch?n=3 -> n x /next (for pre-loading the feed)
    Both accept ?mode=popular to draw from the API's popular-week sort
    (currently very popular) instead of the default whole-catalogue
    random feed (?mode=random).
    GET /api/sauce/{id}/pages -> ALL page image URLs for one gallery,
                                 in order (explicit in-sauce browsing)
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Make the src/ modules importable without changing the repo layout.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from client import NhentaiClient  # noqa: E402

from .config import Settings  # noqa: E402
from .middleware import CacheHeadersMiddleware  # noqa: E402
from .picker import SaucePicker  # noqa: E402
from .routers.meta import create_meta_router  # noqa: E402
from .routers.sauce import create_sauce_router  # noqa: E402
from .stores import DetailCache, RecentServedStore  # noqa: E402


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app with fresh stores and a fresh upstream client."""
    settings = settings if settings is not None else Settings()

    client = NhentaiClient()
    picker = SaucePicker(
        client=client,
        recent=RecentServedStore(maxlen=settings.recent_max),
        details=DetailCache(
            ttl_seconds=settings.detail_ttl_seconds,
            max_entries=settings.detail_cache_max,
        ),
        settings=settings,
    )

    app = FastAPI(title="Sauce Me Up, RNJesus — API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET"],
        allow_headers=["*"],
    )
    app.add_middleware(CacheHeadersMiddleware)

    # Real API routes first; the meta router's /api/{path} catch-all
    # (JSON 404) must be registered after them.
    app.include_router(create_sauce_router(picker))
    app.include_router(create_meta_router())

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
