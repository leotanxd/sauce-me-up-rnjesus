"""HTTP API wrapper around src/sauce_generator.SauceGenerator.

Run:
    pip install -r backend/requirements.txt
    uvicorn backend.api:app --reload --port 8000

Endpoints:
    GET /api/health          -> {"status": "ok"}
    GET /api/sauce/next      -> one random gallery, FIRST page image only
    GET /api/sauce/batch?n=3 -> n x /next (for pre-loading the feed)

Design rule (from the frontend spec): only the first retrieval item is
ever sent to the client — the first page/cover image of one gallery.
No other pages, and no full gallery payload, leave this API.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Make the existing backend importable without changing its layout.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from sauce_generator import SauceGenerator  # noqa: E402

app = FastAPI(title="Sauce Me Up, RNJesus — API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

_generator = SauceGenerator()


def _as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _first_media_path(*sources: dict) -> str | None:
    """Find the first page/cover media path in an API payload, defensively.

    The upstream API has returned several shapes over time, so check the
    known ones in order and return the FIRST item only:
      gallery["thumbnail"], gallery["cover"], gallery["images"]["pages"][0],
      gallery["pages"][0], gallery["thumbnail_url"] / ["cover_url"]
    A value may be a string path/URL or a dict with url/path/src.
    """
    def from_value(v: Any) -> str | None:
        if isinstance(v, str) and v:
            return v
        if isinstance(v, dict):
            for key in ("url", "path", "src"):
                if isinstance(v.get(key), str) and v[key]:
                    return v[key]
        return None

    for src in sources:
        for key in ("thumbnail_url", "cover_url", "thumbnail", "cover"):
            found = from_value(src.get(key))
            if found:
                return found
        images = _as_dict(src.get("images"))
        pages = images.get("pages") or src.get("pages")
        if isinstance(pages, list) and pages:
            found = from_value(pages[0])  # first page only — never the rest
            if found:
                return found
    return None


def _next_sauce() -> dict:
    try:
        gallery = _generator.get_random_english_gallery()
        gallery_id = int(gallery["id"])
    except Exception as error:  # upstream failure / bad payload
        raise HTTPException(status_code=502, detail=str(error)) from error

    detail: dict = {}
    try:
        raw_detail = _generator.get_gallery_details(gallery_id)
        detail = _as_dict(raw_detail.get("result", raw_detail))
    except Exception:
        detail = {}  # details are optional; the search result may suffice

    first_path = _first_media_path(detail, gallery)
    first_image_url: str | None = None
    if first_path:
        if first_path.startswith("http://") or first_path.startswith("https://"):
            first_image_url = first_path
        else:
            try:
                first_image_url = _generator.build_media_url(first_path)
            except Exception:
                first_image_url = None

    title = _as_dict(gallery.get("title") or detail.get("title"))
    return {
        "id": gallery_id,
        "title": title.get("pretty") or title.get("english") or "Untitled",
        "url": _generator.build_gallery_url(gallery),
        # ONLY the first retrieval item. Do not add pages[] here.
        "firstImageUrl": first_image_url,
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/sauce/next")
def sauce_next() -> dict:
    return _next_sauce()


@app.get("/api/sauce/batch")
def sauce_batch(n: int = Query(default=3, ge=1, le=10)) -> dict:
    items, errors = [], 0
    for _ in range(n):
        try:
            items.append(_next_sauce())
        except HTTPException:
            errors += 1
    if not items:
        raise HTTPException(status_code=502, detail="Upstream returned no galleries.")
    return {"items": items, "errors": errors}


# --- Single-service deployment (Render / Docker) -------------------------
# If the frontend has been built (frontend/dist exists, as in the Docker
# image), serve it from this same app so ONE service = ONE public URL.
# The /api routes above are registered first and take precedence.
# In local dev without a build, this is skipped and Vite serves the UI.
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount(
        "/",
        StaticFiles(directory=_FRONTEND_DIST, html=True),
        name="frontend",
    )
