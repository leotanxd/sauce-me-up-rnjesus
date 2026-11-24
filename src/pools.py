"""Search-result pools, one per feed mode.

Each fetched search page yields ~25 galleries and ALL of them are
pooled (shuffled), so one search call serves ~25 picks — roughly a
25x cut in search traffic versus fetching a page per pick. Pages are
drawn at random across the mode's whole result set, so picks are not
limited to the first page.

Modes: FeedMode.RANDOM (the whole English catalogue, newest-first
pages) and FeedMode.POPULAR (the API's popular-week sort — currently
very popular). The pool owns its lock; callers never hold one.
"""

import random
import threading
from enum import StrEnum
from urllib.parse import urlencode

from src.http_client import JsonHttpClient
from src.models import GallerySummary

SEARCH_URL = "https://nhentai.net/api/v2/search"


class FeedMode(StrEnum):
    """The feed modes. The value is the public API spelling (?mode=...)."""

    RANDOM = "random"
    POPULAR = "popular"

    @property
    def sort(self) -> str | None:
        """Upstream search sort for this mode; None = default ordering."""
        return "popular-week" if self is FeedMode.POPULAR else None


def build_search_url(page: int = 1, mode: FeedMode = FeedMode.RANDOM) -> str:
    """Build the API search URL for English-language galleries."""
    params = {"query": "language:english", "page": page}
    if mode.sort is not None:
        params["sort"] = mode.sort
    return f"{SEARCH_URL}?{urlencode(params)}"


class SearchPool:
    """Hands out galleries from per-mode shuffled result pools."""

    def __init__(self, http: JsonHttpClient):
        self._http = http
        self._num_pages: dict[FeedMode, int | None] = {m: None for m in FeedMode}
        self._pool: dict[FeedMode, list] = {m: [] for m in FeedMode}
        self._lock = threading.Lock()

    def _refill(self, mode: FeedMode, deadline: float | None = None) -> None:
        """Fetch one random search page and pool ALL its results.

        Caller must hold self._lock (internal contract of this class).
        """
        if self._num_pages[mode] is None:
            data = self._http.get_json(build_search_url(1, mode), deadline=deadline)
            num_pages = data.get("num_pages")
            self._num_pages[mode] = (
                num_pages if isinstance(num_pages, int) and num_pages > 0 else 1
            )
            results = data.get("result", [])
        else:
            page = random.randint(1, self._num_pages[mode])
            data = self._http.get_json(
                build_search_url(page, mode), deadline=deadline
            )
            results = data.get("result", [])
            if not isinstance(results, list) or not results:
                # Stale/empty page — fall back to page 1.
                data = self._http.get_json(
                    build_search_url(1, mode), deadline=deadline
                )
                results = data.get("result", [])

        if not isinstance(results, list) or not results:
            raise RuntimeError(
                "No English-language galleries were returned by the API."
            )

        pool = [
            summary
            for summary in (GallerySummary.from_search_item(g) for g in results)
            if summary is not None
        ]
        random.shuffle(pool)
        self._pool[mode] = pool

    def next(
        self, mode: FeedMode = FeedMode.RANDOM, deadline: float | None = None
    ) -> GallerySummary:
        """Return one gallery from the mode's pool, refilling if empty."""
        with self._lock:
            if not self._pool[mode]:
                self._refill(mode, deadline=deadline)
            return self._pool[mode].pop()
