"""Search-result pools, one per feed mode.

Each fetched search page yields ~25 galleries and ALL of them are
pooled (shuffled), so one search call serves ~25 picks — roughly a
25x cut in search traffic versus fetching a page per pick. Pages are
drawn at random across the mode's whole result set, so picks are not
limited to the first page.

Modes: FeedMode.RANDOM (the whole English catalogue, newest-first
pages) and FeedMode.POPULAR (the API's popular-week sort — currently
very popular).

Concurrency (Package 3): each mode has its OWN lock, and no lock is
ever held across network I/O. A refill in flight is marked per mode;
draws for the other mode proceed unimpeded, and draws for the
refilling mode wait on that mode's condition instead of starting a
duplicate fetch. When a draw leaves a pool below the low-water mark,
a daemon thread refills it in the background, so the synchronous
refill path (empty pool) becomes rare. There is deliberately no
ready-queue of verified items — background work only ever tops up
the raw search pools.
"""

import contextvars
import logging
import random
import threading
from enum import StrEnum
from urllib.parse import urlencode

from src.http_client import JsonHttpClient
from src.models import GallerySummary
from src.request_context import RequestIdLogFilter

logger = logging.getLogger(__name__)
logger.addFilter(RequestIdLogFilter())

SEARCH_URL = "https://nhentai.net/api/v2/search"

# When a draw leaves fewer than this many galleries in a mode's
# pool, a background refill starts (backend.config.Settings carries
# the same value as pool_low_water_mark and the composition root
# passes it in; this default keeps direct construction — CLI,
# tests — on the same behaviour). 0 disables background refills.
DEFAULT_LOW_WATER_MARK = 5


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


class _ModeState:
    """One mode's pool and its coordination state.

    The condition's lock guards pool/num_pages/refilling only —
    never network I/O. ``refilling`` marks a fetch in flight (a
    synchronous refill by a drawing thread, or a background top-up);
    while it is set, draws that find the pool empty wait on the
    condition rather than duplicating the fetch.
    """

    __slots__ = ("pool", "num_pages", "refilling", "condition")

    def __init__(self):
        self.pool: list = []
        self.num_pages: int | None = None
        self.refilling = False
        self.condition = threading.Condition()


class SearchPool:
    """Hands out galleries from per-mode shuffled result pools."""

    def __init__(
        self,
        http: JsonHttpClient,
        low_water_mark: int = DEFAULT_LOW_WATER_MARK,
        metrics=None,
    ):
        self._http = http
        self._low_water_mark = low_water_mark
        # Package 4 metrics registry or None: refill counts per mode
        # (background refills counted additionally as their subset).
        self._metrics = metrics
        self._states: dict[FeedMode, _ModeState] = {
            m: _ModeState() for m in FeedMode
        }

    def _fetch_page(
        self, mode: FeedMode, deadline: float | None = None
    ) -> list:
        """Fetch one random search page; return its shuffled summaries.

        Performs network I/O and must NOT be called with the mode's
        lock held. Learns the mode's page count on the first fetch
        (written back under the lock; the value is identical whoever
        learns it first, so a concurrent learner is harmless).
        """
        state = self._states[mode]
        num_pages = state.num_pages
        if num_pages is None:
            data = self._http.get_json(build_search_url(1, mode), deadline=deadline)
            learned = data.get("num_pages")
            with state.condition:
                if state.num_pages is None:
                    state.num_pages = (
                        learned
                        if isinstance(learned, int) and learned > 0
                        else 1
                    )
            results = data.get("result", [])
        else:
            page = random.randint(1, num_pages)
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
        if not pool:
            # A page whose items all failed to parse is as unusable
            # as an empty page.
            raise RuntimeError(
                "No English-language galleries were returned by the API."
            )
        random.shuffle(pool)
        if self._metrics is not None:
            # _fetch_page is only ever called to refill a pool (the
            # synchronous path, the background thread, warm-up), so
            # a successful fetch IS a refill.
            self._metrics.pool_refill(mode.value)
        return pool

    def _background_refill(self, mode: FeedMode) -> None:
        """Daemon-thread body: top up one mode's pool off the draw path.

        Failure is not fatal — the pool keeps serving what it has and
        the next empty draw refills synchronously, as before.
        """
        state = self._states[mode]
        page = None
        try:
            page = self._fetch_page(mode)
            if self._metrics is not None:
                self._metrics.pool_background_refill(mode.value)
        except Exception:
            logger.warning(
                "Background refill of the %s search pool failed; "
                "it will refill on demand instead.",
                mode.value,
            )
        with state.condition:
            if page:
                state.pool.extend(page)
                random.shuffle(state.pool)
            state.refilling = False
            state.condition.notify_all()

    def next(
        self, mode: FeedMode = FeedMode.RANDOM, deadline: float | None = None
    ) -> GallerySummary:
        """Return one gallery from the mode's pool, refilling if empty."""
        state = self._states[mode]
        start_background = False
        while True:
            with state.condition:
                if state.pool:
                    item = state.pool.pop()
                    if (
                        self._low_water_mark > 0
                        and len(state.pool) < self._low_water_mark
                        and not state.refilling
                    ):
                        state.refilling = True
                        start_background = True
                    break
                if state.refilling:
                    # A fetch for this mode is already in flight;
                    # wait for it to land instead of duplicating it.
                    state.condition.wait()
                    continue
                state.refilling = True
            # This thread owns the synchronous refill. The fetch runs
            # WITHOUT the lock: the other mode never notices, and
            # this mode's waiters are woken when it lands.
            try:
                page = self._fetch_page(mode, deadline=deadline)
            except BaseException:
                with state.condition:
                    state.refilling = False
                    state.condition.notify_all()
                raise
            with state.condition:
                state.pool.extend(page)
                state.refilling = False
                state.condition.notify_all()
            # Loop around and pop from the refilled pool.
        if start_background:
            # Run the refill in the drawing request's context so its
            # log lines carry that request's ID (Package 4); the
            # refill itself is unaffected by the context copy.
            context = contextvars.copy_context()
            threading.Thread(
                target=lambda: context.run(self._background_refill, mode),
                name=f"searchpool-refill-{mode.value}",
                daemon=True,
            ).start()
        return item
