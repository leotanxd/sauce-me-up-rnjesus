"""HTTP API wrapper around src/sauce_generator.SauceGenerator.

Run:
    pip install -r backend/requirements.txt
    uvicorn backend.api:app --reload --port 8000

Endpoints:
    GET /api/health          -> {"status": "ok"}
    GET /api/sauce/next      -> one random gallery, FIRST page image only
    GET /api/sauce/batch?n=3 -> n x /next (for pre-loading the feed)
    GET /api/sauce/{id}/pages -> ALL page image URLs for one gallery,
                                 in order (explicit in-sauce browsing)

Design rule (from the frontend spec): the FEED only ever receives the
first retrieval item — the first page image of each gallery. The full
page list is available only through /pages, which the frontend calls
on demand when the user pages through a sauce with the arrow keys.
"""

from __future__ import annotations

import sys
from collections import deque
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


def _first_media_path(detail: dict, gallery: dict) -> str | None:
    """Return the FIRST page's relative media path, per the API v2 docs.

    Gallery detail (GalleryDetailResponse) carries:
      pages[]  — each {number, path, width, height, thumbnail, ...}
      cover    — {path, width, height}
      thumbnail— {path, width, height}
    Search items (GalleryListItem) carry only a flat ``thumbnail`` string.
    Paths are relative and must be used exactly as returned; the caller
    prefixes a CDN server from GET /api/v2/cdn (see build_media_url).
    Priority: first page by number, then cover, then thumbnail.
    """
    def path_of(v: Any) -> str | None:
        if isinstance(v, str) and v:
            return v
        if isinstance(v, dict):
            p = v.get("path") or v.get("url")
            if isinstance(p, str) and p:
                return p
        return None

    pages = detail.get("pages")
    if isinstance(pages, list) and pages:
        dict_pages = [p for p in pages if isinstance(p, dict)]
        if dict_pages:
            first = min(
                dict_pages,
                key=lambda p: p.get("number") if isinstance(p.get("number"), int) else 0,
            )
            found = path_of(first)  # first page only — never the rest
            if found:
                return found

    for source, key in (
        (detail, "cover"),
        (detail, "thumbnail"),
        (gallery, "thumbnail"),  # flat string on search items
        (gallery, "cover"),
    ):
        found = path_of(source.get(key))
        if found:
            return found

    # Legacy v1 shape fallback: {"images": {"pages": [...]}}
    legacy_pages = _as_dict(detail.get("images")).get("pages")
    if isinstance(legacy_pages, list) and legacy_pages:
        return path_of(legacy_pages[0])
    return None


# --- No-repeat memory ------------------------------------------------------
# IDs served recently by this process. New picks skip these, so a batch
# never contains duplicates and a refresh shows different sauces. The
# window is bounded; very old IDs become eligible again eventually.
_RECENT_MAX = 300
_recent_ids: deque = deque(maxlen=_RECENT_MAX)
_recent_set: set = set()


def _remember_served(gallery_id: int) -> None:
    if gallery_id in _recent_set:
        return
    if len(_recent_ids) >= _RECENT_MAX:
        _recent_set.discard(_recent_ids[0])
    _recent_ids.append(gallery_id)
    _recent_set.add(gallery_id)


def _is_english(detail: dict) -> bool | None:
    """Check the detail's language tags. None = unknown (no tags to check)."""
    tags = detail.get("tags")
    if not isinstance(tags, list) or not tags:
        return None
    languages = {
        t.get("name")
        for t in tags
        if isinstance(t, dict) and t.get("type") == "language"
    }
    if not languages:
        return None
    return "english" in languages


def _next_sauce() -> dict:
    # The search already filters language:english; still, verify each pick
    # against its detail tags and re-roll a non-English result, so what the
    # API returns — and the frontend displays — is English sauce. Picks
    # also skip anything served recently, so sauces never repeat within a
    # batch or across refreshes (while this process keeps its memory).
    for _attempt in range(8):
        try:
            gallery = _generator.get_random_english_gallery()
            gallery_id = int(gallery["id"])
        except Exception as error:  # upstream failure / bad payload
            raise HTTPException(status_code=502, detail=str(error)) from error

        if gallery_id in _recent_set:
            continue  # already served recently — pick another gallery

        detail: dict = {}
        try:
            raw_detail = _generator.get_gallery_details(gallery_id)
            detail = _as_dict(raw_detail.get("result", raw_detail))
        except Exception:
            detail = {}  # details are optional; the search result may suffice

        if _is_english(detail) is False:
            continue  # not English — pick another gallery

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

        # English title FIRST: the search item's english_title, then the
        # detail's title.english. title.pretty is often the Japanese title
        # even for English galleries, so it is only a last resort.
        title_obj = _as_dict(detail.get("title"))
        _remember_served(gallery_id)
        return {
            "id": gallery_id,
            "title": (
                gallery.get("english_title")
                or title_obj.get("english")
                or title_obj.get("pretty")
                or "Untitled"
            ),
            "url": _generator.build_gallery_url(gallery),
            # ONLY the first retrieval item. Do not add pages[] here.
            "firstImageUrl": first_image_url,
        }

    raise HTTPException(
        status_code=502,
        detail="Could not find a new English-language gallery. Please retry.",
    )


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


@app.get("/api/sauce/{gallery_id}/pages")
def sauce_pages(gallery_id: int) -> dict:
    """All page image URLs for one gallery, in page order.

    The feed itself only ever receives the first page (see /next and
    /batch). This endpoint exists for explicit in-sauce browsing: the
    frontend calls it only when the user starts paging through a sauce
    with the arrow keys / on-screen arrows. URLs are built exactly as
    the API v2 docs prescribe: a CDN image server + the page's path,
    used verbatim.
    """
    try:
        raw_detail = _generator.get_gallery_details(gallery_id)
        detail = _as_dict(raw_detail.get("result", raw_detail))
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    pages = detail.get("pages")
    urls: list[str] = []
    if isinstance(pages, list):
        dict_pages = [p for p in pages if isinstance(p, dict)]
        dict_pages.sort(
            key=lambda p: p.get("number") if isinstance(p.get("number"), int) else 0
        )
        for page in dict_pages:
            path = page.get("path")
            if not isinstance(path, str) or not path:
                continue
            try:
                urls.append(_generator.build_media_url(path))
            except Exception:
                continue

    if not urls:
        # Fallback: at least the first page/cover, same as the feed gets.
        first_path = _first_media_path(detail, {})
        if first_path:
            try:
                urls.append(_generator.build_media_url(first_path))
            except Exception:
                pass
    if not urls:
        raise HTTPException(status_code=502, detail="No page images available.")
    return {"id": gallery_id, "count": len(urls), "images": urls}


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
