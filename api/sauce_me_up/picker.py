"""SaucePicker: the pick orchestration service.

Owns the feed's core policy: draw from the client, skip anything
served recently, verify English against the detail's language tags
(re-rolling non-English picks), shape the feed response (first page
image + total page count only — full page lists leave only through
pages()), and map upstream failures to HTTP errors with generic
client-facing text. All state arrives by injection (client, stores,
settings), so the policy is testable without HTTP.
"""

import contextlib
import contextvars
import logging
import threading
import time
from collections import deque
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor

from fastapi import HTTPException

from sauce_me_up.request_context import RequestIdLogFilter
from sauce_me_up.upstream.errors import ResourceNotFoundError
from sauce_me_up.upstream.models import GalleryDetail
from sauce_me_up.upstream.pools import FeedMode

from .config import Settings
from .schemas import BatchOut, PagesOut, SauceOut
from .stores import DetailCache, RecentServedStore

logger = logging.getLogger(__name__)
logger.addFilter(RequestIdLogFilter())


class SaucePicker:
    def __init__(
        self,
        client,
        recent: RecentServedStore,
        details: DetailCache,
        settings: Settings,
        metrics=None,
    ):
        self._client = client
        self._recent = recent
        self._details = details
        self._settings = settings
        # Package 4 metrics registry or None: pick outcomes, detail
        # cache hit/miss, and batch durations are counted when one
        # is wired in.
        self._metrics = metrics
        # Detail single-flight (Package 2): gallery_id -> the Future
        # of the one in-flight upstream fetch for it. Guarded by its
        # own lock, held only to look up / register / clear a flight
        # — never across the fetch itself.
        self._detail_flights: dict[int, Future] = {}
        self._detail_flights_lock = threading.Lock()

    def _get_detail(
        self, gallery_id: int, deadline: float | None = None
    ) -> GalleryDetail:
        hit = self._details.get(gallery_id)
        if self._metrics is not None:
            if hit is not None:
                self._metrics.detail_cache_hit()
            else:
                self._metrics.detail_cache_miss()
        if hit is not None:
            return hit

        # Join or start the one fetch for this gallery. Concurrent
        # picks (batch concurrency) and a pick racing /pages for the
        # same gallery otherwise each spend a detail call — the
        # scarcest upstream resource — on identical work.
        with self._detail_flights_lock:
            flight = self._detail_flights.get(gallery_id)
            if flight is None:
                flight = Future()
                self._detail_flights[gallery_id] = flight
                owner = True
            else:
                owner = False

        if owner:
            try:
                detail = self._client.get_gallery_details(gallery_id, deadline=deadline)
                # Cache BEFORE completing the flight: a caller who
                # arrives after the flight is cleared hits the cache
                # instead of starting a second fetch.
                self._details.put(gallery_id, detail)
                flight.set_result(detail)
                return detail
            except BaseException as error:
                # Waiters receive this same exception (a 404 stays a
                # ResourceNotFoundError, a transient failure stays
                # transient) — sharing the verdict is the point.
                flight.set_exception(error)
                raise
            finally:
                with self._detail_flights_lock:
                    if self._detail_flights.get(gallery_id) is flight:
                        del self._detail_flights[gallery_id]

        # Waiter: share the owner's fetch, but only until OUR
        # deadline — the fetch continues for the other callers, and
        # this caller treats the wait the way it treats any other
        # transient detail failure (re-roll / 502 upstream).
        try:
            timeout = (
                None if deadline is None else max(0.0, deadline - time.monotonic())
            )
            return flight.result(timeout=timeout)
        except TimeoutError:
            if flight.done():
                raise  # the fetch's own TimeoutError, not our wait
            raise RuntimeError(
                "Timed out waiting for the in-flight detail fetch "
                f"for gallery {gallery_id}."
            ) from None
        except CancelledError:
            # The flight bookkeeping itself failed (the shared
            # future was cancelled): fall back to fetching directly
            # rather than failing a pick over shared-state plumbing.
            detail = self._client.get_gallery_details(gallery_id, deadline=deadline)
            self._details.put(gallery_id, detail)
            return detail

    def _serve(
        self, gallery, detail: GalleryDetail, deadline: float | None = None
    ) -> SauceOut:
        """Shape one feed item and return it.

        Shared by the normal verified serve and the last-resort
        unverified fallback (which passes GalleryDetail.empty). The
        gallery's ID was remembered at reservation time in next() —
        this method does no store bookkeeping.
        """
        gallery_id = gallery.id
        first_path = detail.first_media_path(gallery)
        first_image_url: str | None = None
        if first_path:
            if first_path.startswith(("http://", "https://")):
                first_image_url = first_path
            else:
                try:
                    first_image_url = self._client.build_media_url(
                        first_path, deadline=deadline
                    )
                except Exception:
                    first_image_url = None

        return SauceOut(
            id=gallery_id,
            # Title priority lives on the models: search
            # english_title, then detail title.english, then
            # title.pretty (last resort), then "Untitled".
            title=detail.display_title(gallery),
            url=self._client.build_gallery_url(gallery),
            # ONLY the first retrieval item. No pages[] here.
            first_image_url=first_image_url,
            # Total page count comes free from the detail
            # already fetched for verification — the feed
            # shows "Page 1 of N" without page URLs ever
            # leaving the /pages endpoint.
            page_count=detail.page_count,
        )

    def next(
        self, mode: FeedMode = FeedMode.RANDOM, deadline: float | None = None
    ) -> SauceOut:
        # The search already filters language:english; still, verify
        # each pick against its detail tags and re-roll a non-English
        # result, so what the API returns — and the frontend displays —
        # is English sauce. Picks also skip anything served recently.
        #
        # Locking: the only atomic step is check-and-reserve — "not in
        # the recent set" + remember, in one hold of the store's lock,
        # so concurrent picks can never reserve the same ID. The draw,
        # the detail fetch, and the media-URL build all run outside
        # the lock (the pool, detail cache, and CDN builder lock
        # themselves). A candidate that earns a verdict (non-English,
        # detail 404, or the transient-failure fallback) keeps its
        # reservation; if the pick raises outright, every reservation
        # it made is released, leaving the window as it found it.
        if deadline is None:
            deadline = time.monotonic() + self._settings.pick_budget_seconds

        # A candidate whose detail fetch fails transiently is kept as
        # a last-resort fallback (see the end of this method): re-roll
        # for a verified pick first, and only serve unverified if
        # every attempt fails. A detail 404 is never a fallback — the
        # gallery effectively doesn't exist upstream.
        fallback: tuple | None = None
        reserved: list[int] = []

        try:
            for _attempt in range(8):
                if time.monotonic() > deadline:
                    break
                try:
                    gallery = self._client.get_random_english_gallery(
                        deadline=deadline, mode=mode
                    )
                    gallery_id = gallery.id
                except Exception as error:  # upstream failure / bad payload
                    logger.warning("Pick failed: %s", error)
                    raise HTTPException(
                        status_code=502, detail=self._settings.upstream_502_text
                    ) from error

                # Check-and-reserve: the one atomic unit.
                with self._recent.lock:
                    if gallery_id in self._recent:
                        continue  # served or reserved — pick another
                    self._recent.remember(gallery_id)
                    reserved.append(gallery_id)

                try:
                    detail = self._get_detail(gallery_id, deadline=deadline)
                except ResourceNotFoundError:
                    # Detail 404: not transient, and never served.
                    logger.warning(
                        "Detail for gallery %s returned 404; re-rolling.",
                        gallery_id,
                    )
                    if self._metrics is not None:
                        self._metrics.pick_rerolled()
                    continue
                except Exception as error:
                    # Transient failure (the transport already retried
                    # this gallery): substitute a different gallery
                    # instead of serving this one unverified.
                    logger.warning(
                        "Detail fetch for gallery %s failed (%s); re-rolling.",
                        gallery_id,
                        error,
                    )
                    if self._metrics is not None:
                        self._metrics.pick_rerolled()
                    if fallback is None:
                        fallback = (gallery, gallery_id)
                    continue

                if detail.is_english is False:
                    if self._metrics is not None:
                        self._metrics.pick_rerolled()
                    continue  # not English — pick another gallery

                if self._metrics is not None:
                    self._metrics.pick_served()
                return self._serve(gallery, detail, deadline=deadline)

            if fallback is not None:
                # Every attempt failed to verify: serve the first
                # transiently-failed candidate unverified rather than
                # hard-failing the feed. Accepted on the search filter
                # alone — visible in logs so silent degradation is
                # noticed.
                gallery, gallery_id = fallback
                logger.warning(
                    "Serving gallery %s without detail verification.",
                    gallery_id,
                )
                if self._metrics is not None:
                    self._metrics.pick_fallback()
                return self._serve(
                    gallery,
                    GalleryDetail.empty(gallery_id),
                    deadline=deadline,
                )

            raise HTTPException(
                status_code=502,
                detail="Could not find a new English-language gallery in time. Please retry.",
            )
        except HTTPException:
            if self._metrics is not None:
                self._metrics.pick_error()
            # A failed pick remembers nothing: release its reservations.
            for gallery_id in reserved:
                self._recent.forget(gallery_id)
            raise

    def batch(self, n: int, mode: FeedMode = FeedMode.RANDOM) -> BatchOut:
        # Package 4: every batch's wall time lands in the metrics
        # duration summary, however the batch ends (served, partial,
        # or the all-failed 502 below).
        started = time.monotonic()
        try:
            return self._batch(n, mode)
        finally:
            if self._metrics is not None:
                self._metrics.observe_batch_duration(time.monotonic() - started)

    def _batch(self, n: int, mode: FeedMode = FeedMode.RANDOM) -> BatchOut:
        # One overall deadline for the batch: return what was
        # generated in time rather than hanging. (The default n at the
        # route mirrors the frontend's BATCH_SIZE in
        # web/src/lib/config.ts — keep them in step.)
        #
        # Picks run concurrently (up to Settings.batch_concurrency in
        # flight) on a per-call executor — no long-lived pool to leak.
        # Submission is lazy, mirroring the old sequential accounting:
        # the deadline is checked before each new submission, and a
        # cut adds one error and stops submitting; results are
        # collected in submission order, each pick's 502 adding an
        # error. The shared deadline is passed to every pick.
        #
        # Collection is hardened two ways. Each future is awaited
        # with at most the time left in the batch budget, so one
        # hanging pick costs an error, not the whole batch's wait;
        # and ANY exception escaping a pick — not just the
        # HTTPExceptions next() maps deliberately, but e.g. a
        # RuntimeError from URL building inside _serve — degrades to
        # a counted error instead of 500ing the batch. The executor
        # is shut down without waiting: a pick still running past
        # the deadline finishes (or fails) in the background with
        # its result discarded, and queued picks are cancelled.
        deadline = time.monotonic() + self._settings.batch_budget_seconds
        cap = max(1, self._settings.batch_concurrency)
        items: list[SauceOut] = []
        errors = 0
        executor = ThreadPoolExecutor(max_workers=cap)
        try:
            in_flight: deque[Future] = deque()
            submitted = 0
            while submitted < n or in_flight:
                while submitted < n and len(in_flight) < cap:
                    if time.monotonic() > deadline:
                        errors += 1
                        submitted = n  # deadline cut: stop submitting
                        break
                    # Picks run on raw executor threads, which do
                    # NOT inherit contextvars: copy the request
                    # context in so the picks' log lines carry this
                    # request's ID (Package 4).
                    context = contextvars.copy_context()
                    in_flight.append(
                        executor.submit(
                            context.run,
                            self.next,
                            deadline=deadline,
                            mode=mode,
                        )
                    )
                    submitted += 1
                if not in_flight:
                    break
                future = in_flight.popleft()
                try:
                    remaining = max(0.0, deadline - time.monotonic())
                    items.append(future.result(timeout=remaining))
                except HTTPException:
                    errors += 1
                except Exception as error:
                    # Bounded-wait timeout, or a non-HTTP failure
                    # next() didn't map: a counted error either way.
                    errors += 1
                    logger.warning("Batch pick failed: %s", error)
        finally:
            executor.shutdown(wait=False, cancel_futures=True)
        if not items:
            raise HTTPException(
                status_code=502, detail="Upstream returned no galleries."
            )
        return BatchOut(items=items, errors=errors)

    def pages(self, gallery_id: int) -> PagesOut:
        """All page image URLs for one gallery, in page order.

        The feed itself only ever receives the first page (see next /
        batch). This exists for explicit in-sauce browsing: the
        frontend calls it only when the user starts paging through a
        sauce. URLs are built exactly as the API v2 docs prescribe: a
        CDN image server + the page's path, used verbatim.
        """
        deadline = time.monotonic() + self._settings.pick_budget_seconds
        try:
            detail = self._get_detail(gallery_id, deadline=deadline)
        except ResourceNotFoundError as error:
            raise HTTPException(status_code=404, detail="Gallery not found.") from error
        except Exception as error:
            logger.warning("Detail fetch for %s failed: %s", gallery_id, error)
            raise HTTPException(
                status_code=502, detail=self._settings.upstream_502_text
            ) from error

        # Page paths arrive pre-sorted from the model (by page number,
        # number-less pages last) — the one ordering definition.
        urls: list[str] = []
        for path in detail.page_paths:
            try:
                urls.append(self._client.build_media_url(path, deadline=deadline))
            except Exception as error:
                # All-or-nothing: a silently dropped middle page would
                # shift every later "Page X of Y" label off the truth.
                logger.warning(
                    "Page URL build failed for gallery %s: %s", gallery_id, error
                )
                raise HTTPException(
                    status_code=502, detail=self._settings.upstream_502_text
                ) from error

        if not urls:
            # Fallback: at least the first page/cover, as the feed gets.
            first_path = detail.first_media_path()
            if first_path:
                with contextlib.suppress(Exception):
                    urls.append(
                        self._client.build_media_url(first_path, deadline=deadline)
                    )
        if not urls:
            raise HTTPException(status_code=502, detail="No page images available.")
        return PagesOut(id=gallery_id, count=len(urls), images=urls)
