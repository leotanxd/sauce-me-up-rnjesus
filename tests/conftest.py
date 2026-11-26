"""Shared fakes for the offline test suite. No live network anywhere.

- ``fake_transport``: scripts the transport seam of JsonHttpClient
  (``src.http_client._create_default_transport`` is patched to hand
  out the fake) and ``time.sleep`` (retry backoffs are recorded, not
  slept — they are seconds long).
- ``FakeClient``: a scripted stand-in for NhentaiClient for picker
  tests — a queue of draws plus per-ID detail outcomes.
- ``make_picker``: wires a client to real stores + default Settings.
"""

import json
import threading
import time
from pathlib import Path

import httpx
import pytest

from backend.config import Settings
from backend.picker import SaucePicker
from backend.stores import DetailCache, RecentServedStore
from src import http_client as http_client_module
from src.models import GalleryDetail, GallerySummary

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def search_page():
    return load_fixture("search_page.json")


@pytest.fixture
def gallery_detail():
    return load_fixture("gallery_detail.json")


class _StubResponse:
    """The transport seam's response shape: status + headers + body."""

    def __init__(self, status: int, headers: dict, body: bytes):
        self.status_code = status
        self.headers = headers
        self.content = body


class FakeTransport:
    """A scripted transport replacement. Outcomes are consumed in order."""

    def __init__(self):
        self.outcomes: list = []
        self.calls: list[str] = []  # requested URLs, in order
        self.sleeps: list[float] = []  # recorded backoff delays

    # -- scripting ---------------------------------------------------
    def push_json(self, payload) -> None:
        self.outcomes.append(("json", payload))

    def push_raw(self, body: bytes) -> None:
        self.outcomes.append(("raw", body))

    def push_http(self, status: int, headers: dict | None = None) -> None:
        self.outcomes.append(("http", status, headers or {}))

    def push_url_error(self, reason: str = "connection refused") -> None:
        self.outcomes.append(("urlerror", reason))

    # -- the transport / sleep stand-ins ------------------------------
    def get(self, url, headers, timeout=None):
        self.calls.append(url)
        if not self.outcomes:
            raise AssertionError(f"FakeTransport: unscripted request to {url}")
        outcome = self.outcomes.pop(0)
        kind = outcome[0]
        if kind == "json":
            body = json.dumps(outcome[1]).encode("utf-8")
            return _StubResponse(200, {}, body)
        if kind == "raw":
            return _StubResponse(200, {}, outcome[1])
        if kind == "http":
            _, status, headers = outcome
            return _StubResponse(status, headers, b"")
        if kind == "urlerror":
            raise httpx.ConnectError(outcome[1])
        raise AssertionError(f"FakeTransport: unknown outcome {outcome!r}")

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)


@pytest.fixture
def fake_transport(monkeypatch):
    transport = FakeTransport()
    monkeypatch.setattr(
        http_client_module,
        "_create_default_transport",
        lambda: transport,
    )
    monkeypatch.setattr("time.sleep", transport.sleep)
    return transport


def make_detail(
    gallery_id: int,
    *,
    languages=("english",),
    pages: int = 2,
    english_title: str | None = None,
) -> GalleryDetail:
    """A parsed GalleryDetail with the given language tags/page count."""
    return GalleryDetail.from_detail(
        {
            "title": {
                "english": english_title or f"Detail {gallery_id}",
                "pretty": f"Pretty {gallery_id}",
            },
            "cover": {"path": f"galleries/{gallery_id}/cover.jpg"},
            "thumbnail": {"path": f"galleries/{gallery_id}/thumb.jpg"},
            "pages": [
                {"number": i + 1, "path": f"galleries/{gallery_id}/{i + 1}.jpg"}
                for i in range(pages)
            ],
            "tags": [{"type": "language", "name": lang} for lang in languages],
        },
        gallery_id,
    )


class FakeClient:
    """Scripted NhentaiClient stand-in for SaucePicker tests.

    ``draws`` is a queue consumed one per get_random_english_gallery
    call: an int serves that gallery ID; an Exception instance is
    raised. ``details`` maps gallery ID -> GalleryDetail to return or
    Exception to raise from get_gallery_details (default: an English
    detail with 2 pages). ``media_fail_paths`` makes build_media_url
    raise for those relative paths. Thread-safe (the picker may call
    from a thread pool).
    """

    def __init__(self, draws=(), details=None, media_fail_paths=(), detail_delay=0.0):
        self._draws = list(draws)
        self._details = dict(details or {})
        self._media_fail_paths = set(media_fail_paths)
        self._detail_delay = detail_delay
        self._lock = threading.Lock()
        self.draw_calls = 0
        self.detail_calls: list[int] = []

    def get_random_english_gallery(self, deadline=None, mode=None):
        with self._lock:
            self.draw_calls += 1
            if not self._draws:
                raise RuntimeError("FakeClient: draw queue exhausted")
            item = self._draws.pop(0)
        if isinstance(item, Exception):
            raise item
        return GallerySummary(
            id=item,
            english_title=f"Title {item}",
            thumbnail_path=f"galleries/{item}/thumb.jpg",
            cover_path=None,
        )

    def get_gallery_details(self, gallery_id, deadline=None):
        if self._detail_delay:
            time.sleep(self._detail_delay)
        with self._lock:
            self.detail_calls.append(gallery_id)
            outcome = self._details.get(gallery_id)
        if outcome is None:
            return make_detail(gallery_id)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def build_media_url(self, relative_media_path, deadline=None):
        if relative_media_path in self._media_fail_paths:
            raise RuntimeError(
                f"FakeClient: CDN build failed for {relative_media_path}"
            )
        return f"https://cdn.example/{relative_media_path}"

    def build_gallery_url(self, gallery):
        gallery_id = gallery.id if isinstance(gallery, GallerySummary) else gallery
        return f"https://nhentai.net/g/{gallery_id}/"


def make_picker(
    client, settings=None, recent=None, details=None, metrics=None
) -> SaucePicker:
    return SaucePicker(
        client=client,
        recent=recent if recent is not None else RecentServedStore(),
        details=details if details is not None else DetailCache(),
        settings=settings if settings is not None else Settings(),
        metrics=metrics,
    )
