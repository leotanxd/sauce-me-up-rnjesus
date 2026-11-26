"""Playwright E2E stub: the REAL app + a generative fake upstream.

Test-only launcher (never imported by the app). It patches the
transport seam of JsonHttpClient — the same seam the pytest fakes
use (``sauce_me_up.upstream.http_client._create_default_transport``) — with a
generative fake that answers the upstream's search / detail / CDN
endpoints from synthetic data, then serves the real FastAPI app
(``sauce_me_up.app.create_app``) with uvicorn. Media bytes come from a
tiny image HTTP server in the same process, so the browser really
loads and decodes images (the CDN config points at it):

- normal pages: 800x1100 PNG; covers/thumbs: 300x420 PNG
- every gallery's page 3 is a "strip" page (120x3600 PNG), so the
  strip-rendering path is exercised deterministically.

Configuration is via environment (set by playwright.config.ts):
- E2E_APP_PORT   port for the app (default 8901)
- E2E_IMG_PORT   port for the image/control server (default 8902)
- E2E_FAIL_SEARCH=1  start with search requests failing, for the
  error/retry spec. Flip it live via the control endpoints:
  GET /__control/fail-search/on|off on the image port.

Budgets are shrunk (Settings) so a failing batch resolves in
seconds instead of the production 45s; everything else is the
real app with default behaviour.
"""

import json
import os
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

import httpx  # noqa: E402
import uvicorn  # noqa: E402

APP_PORT = int(os.environ.get("E2E_APP_PORT", "8901"))
IMG_PORT = int(os.environ.get("E2E_IMG_PORT", "8902"))
IMG_BASE = f"http://127.0.0.1:{IMG_PORT}"

# The stub catalogue must be much larger than the suite's total
# consumption: the app's no-repeat window remembers every served
# gallery for the life of the process, and all specs share one
# server — a 25-gallery catalogue is exhausted after a few specs
# and later feeds can only 502. 20 pages x 25 = 500 galleries.
SEARCH_PAGES = 20
SEARCH_PAGE_SIZE = 25
FIRST_GALLERY_ID = 101
PAGES_PER_GALLERY = 6
STRIP_PAGE = 3

STATE = {"fail_search": os.environ.get("E2E_FAIL_SEARCH") == "1"}
STATE_LOCK = threading.Lock()


def set_fail_search(value: bool) -> None:
    with STATE_LOCK:
        STATE["fail_search"] = value


def fail_search() -> bool:
    with STATE_LOCK:
        return STATE["fail_search"]


# ------------------------------------------------------------------
# PNG generation (stdlib only): solid-colour images whose natural
# size is exactly what the frontend measures for strip detection.
# ------------------------------------------------------------------

_PNG_CACHE: dict[tuple[int, int], bytes] = {}


def make_png(width: int, height: int) -> bytes:
    key = (width, height)
    if key in _PNG_CACHE:
        return _PNG_CACHE[key]

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + bytes((120, 130, 140)) * width
    idat = zlib.compress(row * height, 9)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )
    _PNG_CACHE[key] = png
    return png


class ImageHandler(BaseHTTPRequestHandler):
    """Serves control endpoints + a PNG for every other path."""

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path == "/__control/fail-search/on":
            set_fail_search(True)
            return self._json({"fail_search": True})
        if self.path == "/__control/fail-search/off":
            set_fail_search(False)
            return self._json({"fail_search": False})
        if self.path == "/__control/state":
            return self._json({"fail_search": fail_search()})
        if "strip" in self.path:
            body = make_png(120, 3600)
        elif "thumb" in self.path or "cover" in self.path:
            body = make_png(300, 420)
        else:
            body = make_png(800, 1100)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:  # keep test output clean
        pass


# ------------------------------------------------------------------
# The generative fake transport (the JsonHttpClient seam shape:
# get(url, headers, timeout) -> object with status_code / headers /
# content; network failures raise httpx.TransportError).
# ------------------------------------------------------------------


class _Response:
    def __init__(self, payload: dict):
        self.status_code = 200
        self.headers: dict = {}
        self.content = json.dumps(payload).encode("utf-8")


def _media_id(gallery_id: int) -> int:
    return 9000 + gallery_id


def _search_payload(url: str) -> dict:
    from urllib.parse import parse_qs, urlparse

    page = int(parse_qs(urlparse(url).query).get("page", ["1"])[0])
    first = FIRST_GALLERY_ID + (page - 1) * SEARCH_PAGE_SIZE
    return {
        "num_pages": SEARCH_PAGES,
        "result": [
            {
                "id": gid,
                "media_id": str(_media_id(gid)),
                "english_title": f"Stub Gallery {gid}",
                "thumbnail": f"galleries/{_media_id(gid)}/thumb.jpg",
            }
            for gid in range(first, first + SEARCH_PAGE_SIZE)
        ],
    }


def _detail_payload(gallery_id: int) -> dict:
    media = _media_id(gallery_id)
    pages = []
    for number in range(1, PAGES_PER_GALLERY + 1):
        name = f"strip-{number}.jpg" if number == STRIP_PAGE else f"{number}.jpg"
        pages.append({"number": number, "path": f"galleries/{media}/{name}"})
    return {
        "id": gallery_id,
        "title": {
            "english": f"Stub Gallery {gallery_id}",
            "japanese": f"Stub Gallery {gallery_id}",
            "pretty": f"Stub Gallery {gallery_id}",
        },
        "cover": {"path": f"galleries/{media}/cover.jpg"},
        "thumbnail": {"path": f"galleries/{media}/thumb.jpg"},
        "pages": pages,
        "tags": [
            {"type": "language", "name": "english"},
            {"type": "language", "name": "translated"},
        ],
    }


class FakeTransport:
    def get(self, url, headers, timeout=None):
        if "/api/v2/cdn" in url:
            return _Response(
                {"image_servers": [IMG_BASE], "thumb_servers": [IMG_BASE]}
            )
        if "/api/v2/search" in url:
            if fail_search():
                raise httpx.ConnectError("stub: search endpoint down")
            return _Response(_search_payload(url))
        if "/api/v2/galleries/" in url:
            gallery_id = int(url.rsplit("/", 1)[-1].split("?")[0])
            return _Response(_detail_payload(gallery_id))
        raise AssertionError(f"FakeTransport: unscripted request to {url}")


def main() -> None:
    images = ThreadingHTTPServer(("127.0.0.1", IMG_PORT), ImageHandler)
    threading.Thread(target=images.serve_forever, daemon=True).start()

    from sauce_me_up.upstream import http_client as http_client_module

    http_client_module._create_default_transport = lambda: FakeTransport()  # noqa: SLF001

    from sauce_me_up.app import create_app
    from sauce_me_up.config import Settings

    settings = Settings(
        pick_budget_seconds=5.0,
        batch_budget_seconds=8.0,
        warm_up_deadline_seconds=3.0,
        # The suite browses far faster than a human visitor; the
        # global budget exists to bound real upstream storms (and is
        # unit-tested in pytest), so it is effectively lifted here —
        # otherwise later specs starve on an empty token bucket.
        global_budget_rate_per_minute=100_000.0,
        global_budget_burst=10_000,
    )
    app = create_app(settings)
    uvicorn.run(app, host="127.0.0.1", port=APP_PORT, log_level="warning")


if __name__ == "__main__":
    main()
