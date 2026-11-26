"""SaucePicker policy: verification, re-rolls, no-repeat, accounting."""

import threading
import time

import pytest
from conftest import FakeClient, make_detail, make_picker
from fastapi import HTTPException

from backend.config import Settings
from backend.stores import RecentServedStore
from src.errors import ResourceNotFoundError
from src.http_client import JsonHttpClient
from src.models import GallerySummary
from src.pools import FeedMode, SearchPool

NOT_FOUND = ResourceNotFoundError("gone")
TRANSIENT = RuntimeError("upstream hiccup")


def test_happy_path_shape_and_remember():
    recent = RecentServedStore()
    picker = make_picker(FakeClient(draws=[1]), recent=recent)
    item = picker.next()
    assert item.id == 1
    assert item.title == "Title 1"  # search title wins the priority
    assert item.url == "https://nhentai.net/g/1/"
    assert item.first_image_url == "https://cdn.example/galleries/1/1.jpg"
    assert item.page_count == 2  # from the detail, free with verification
    assert 1 in recent


def test_non_english_pick_is_rerolled_not_served():
    client = FakeClient(
        draws=[1, 2],
        details={1: make_detail(1, languages=("japanese",))},
    )
    picker = make_picker(client)
    assert picker.next().id == 2


def test_recent_duplicate_is_skipped_before_any_detail_fetch():
    recent = RecentServedStore()
    recent.remember(1)
    client = FakeClient(draws=[1, 2])
    picker = make_picker(client, recent=recent)
    assert picker.next().id == 2
    assert client.detail_calls == [2]  # 1 was skipped on the recent check


def test_draw_failure_maps_to_502():
    picker = make_picker(FakeClient(draws=[RuntimeError("upstream down")]))
    with pytest.raises(HTTPException) as excinfo:
        picker.next()
    assert excinfo.value.status_code == 502


def test_detail_transient_failure_rerolls_to_a_verified_pick():
    client = FakeClient(draws=[1, 2], details={1: TRANSIENT})
    picker = make_picker(client)
    assert picker.next().id == 2


def test_detail_404_is_never_served():
    client = FakeClient(draws=[1, 2], details={1: NOT_FOUND})
    picker = make_picker(client)
    assert picker.next().id == 2


def test_all_transient_failures_serve_the_first_unverified_once():
    client = FakeClient(draws=[1, 2] * 4, details={1: TRANSIENT, 2: TRANSIENT})
    picker = make_picker(client)
    item = picker.next()
    assert item.id == 1  # the first transient failure, as the fallback
    assert item.page_count is None  # unverified: no detail, no count


def test_all_404_raises_502_and_remembers_nothing():
    recent = RecentServedStore()
    client = FakeClient(draws=[1, 2] * 4, details={1: NOT_FOUND, 2: NOT_FOUND})
    picker = make_picker(client, recent=recent)
    with pytest.raises(HTTPException) as excinfo:
        picker.next()
    assert excinfo.value.status_code == 502
    assert 1 not in recent
    assert 2 not in recent


def test_batch_happy_path():
    picker = make_picker(FakeClient(draws=[1, 2, 3]))
    result = picker.batch(3)
    assert result.errors == 0
    assert sorted(item.id for item in result.items) == [1, 2, 3]


def test_batch_partial_failure_accounting():
    client = FakeClient(draws=[10, RuntimeError("draw boom"), 11])
    picker = make_picker(client)
    result = picker.batch(3)
    assert result.errors == 1
    assert sorted(item.id for item in result.items) == [10, 11]


def test_batch_with_nothing_served_raises_502():
    client = FakeClient(draws=[1, 2] * 8, details={1: NOT_FOUND, 2: NOT_FOUND})
    picker = make_picker(client)
    with pytest.raises(HTTPException) as excinfo:
        picker.batch(2)
    assert excinfo.value.status_code == 502


def test_pages_happy_path():
    picker = make_picker(FakeClient())
    result = picker.pages(5)
    assert result.id == 5
    assert result.count == 2
    assert result.images == [
        "https://cdn.example/galleries/5/1.jpg",
        "https://cdn.example/galleries/5/2.jpg",
    ]


def test_pages_404_maps_to_404():
    picker = make_picker(FakeClient(details={5: NOT_FOUND}))
    with pytest.raises(HTTPException) as excinfo:
        picker.pages(5)
    assert excinfo.value.status_code == 404


def test_pages_url_build_failure_is_all_or_nothing_502():
    picker = make_picker(FakeClient(media_fail_paths={"galleries/5/2.jpg"}))
    with pytest.raises(HTTPException) as excinfo:
        picker.pages(5)
    assert excinfo.value.status_code == 502


# --- Concurrency: check-and-reserve + parallel batches -------------------


def test_verdict_candidates_keep_their_reservations():
    # A transiently-failed candidate is a bad redraw candidate: its
    # reservation is kept even though another gallery was served.
    recent = RecentServedStore()
    client = FakeClient(draws=[1, 2], details={1: TRANSIENT})
    picker = make_picker(client, recent=recent)
    assert picker.next().id == 2
    assert 1 in recent
    assert 2 in recent


def test_parallel_batch_of_ten_is_unique_and_faster_than_sequential():
    client = FakeClient(draws=list(range(1, 11)), detail_delay=0.25)
    picker = make_picker(client)
    started = time.monotonic()
    result = picker.batch(10)
    elapsed = time.monotonic() - started
    assert result.errors == 0
    assert sorted(item.id for item in result.items) == list(range(1, 11))
    # Sequential would take >= 10 x 0.25s = 2.5s of detail latency.
    assert elapsed < 1.5


def test_concurrent_batches_never_serve_a_duplicate():
    recent = RecentServedStore()
    client = FakeClient(draws=list(range(1, 400)))
    picker = make_picker(client, recent=recent)
    served: list[int] = []
    failures: list[Exception] = []

    def run_batch():
        try:
            result = picker.batch(10)
            served.extend(item.id for item in result.items)
        except Exception as error:  # pragma: no cover - failure path
            failures.append(error)

    threads = [threading.Thread(target=run_batch) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert failures == []
    assert len(served) == 80
    assert len(set(served)) == 80  # zero duplicates across all batches
    assert set(recent._ids) == recent._set


def test_batch_deadline_cut_submits_nothing():
    client = FakeClient(draws=[1, 2, 3])
    picker = make_picker(client, settings=Settings(batch_budget_seconds=0.0))
    with pytest.raises(HTTPException) as excinfo:
        picker.batch(3)
    assert excinfo.value.status_code == 502
    assert client.draw_calls == 0


# --- Batch hardening: non-HTTP failures + the wall-clock bound -----------


class _UrlBoomClient(FakeClient):
    """Gallery-URL building blows up for one gallery: a RuntimeError
    escaping _serve, which next() never maps to an HTTPException."""

    def build_gallery_url(self, gallery):
        if getattr(gallery, "id", gallery) == 2:
            raise RuntimeError("url build boom")
        return super().build_gallery_url(gallery)


def test_batch_non_http_exception_is_a_counted_error_not_a_500():
    picker = make_picker(_UrlBoomClient(draws=[1, 2, 3]))
    result = picker.batch(3)
    assert result.errors == 1
    assert sorted(item.id for item in result.items) == [1, 3]


class _HangingDetailClient(FakeClient):
    """Gallery 1's detail fetch blocks until the test releases it —
    a pick that hangs outright, ignoring the deadline it was given."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.release = threading.Event()

    def get_gallery_details(self, gallery_id, deadline=None):
        if gallery_id == 1:
            self.release.wait(timeout=30)
        return super().get_gallery_details(gallery_id, deadline=deadline)


def test_batch_returns_within_budget_when_a_pick_hangs():
    client = _HangingDetailClient(draws=[1, 2, 3])
    picker = make_picker(client, settings=Settings(batch_budget_seconds=0.5))
    started = time.monotonic()
    try:
        result = picker.batch(3)
    finally:
        client.release.set()  # let the abandoned pick thread finish
    elapsed = time.monotonic() - started
    # Acceptance bound: the batch budget (0.5s) + 2s of slack. The
    # hanging pick must cost an error, not the batch's whole wait.
    assert elapsed < 2.5
    assert result.errors >= 1
    assert sorted(item.id for item in result.items) == [2, 3]


# --- Package 2: detail single-flight --------------------------------------


class _GatedDetailClient(FakeClient):
    """Detail fetches pause at a gate, so a test can pile concurrent
    callers onto one in-flight fetch before releasing it."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.entered = threading.Event()
        self.release = threading.Event()

    def get_gallery_details(self, gallery_id, deadline=None):
        self.entered.set()
        self.release.wait(timeout=10)
        return super().get_gallery_details(gallery_id, deadline=deadline)


def _call_in_thread(fn, results, errors):
    try:
        results.append(fn())
    except Exception as error:  # collected and asserted by the test
        errors.append(error)


def test_single_flight_eight_callers_share_one_fetch():
    client = _GatedDetailClient()
    picker = make_picker(client)
    results: list = []
    errors: list = []

    owner = threading.Thread(
        target=_call_in_thread,
        args=(lambda: picker._get_detail(7), results, errors),
    )
    owner.start()
    assert client.entered.wait(timeout=5)  # the one fetch is in flight

    waiters = [
        threading.Thread(
            target=_call_in_thread,
            args=(lambda: picker._get_detail(7), results, errors),
        )
        for _ in range(7)
    ]
    for thread in waiters:
        thread.start()
    time.sleep(0.3)  # let every waiter pile onto the flight
    client.release.set()
    owner.join(timeout=5)
    for thread in waiters:
        thread.join(timeout=5)

    assert errors == []
    assert len(results) == 8
    assert client.detail_calls == [7]  # exactly ONE upstream fetch
    assert all(result is results[0] for result in results)  # same object
    # And the completed flight populated the cache for later callers.
    assert picker._get_detail(7) is results[0]
    assert client.detail_calls == [7]


def test_single_flight_waiter_deadline_stops_waiting_fetch_continues():
    client = _GatedDetailClient()
    picker = make_picker(client)
    results: list = []
    errors: list = []

    owner = threading.Thread(
        target=_call_in_thread,
        args=(lambda: picker._get_detail(7), results, errors),
    )
    owner.start()
    assert client.entered.wait(timeout=5)

    started = time.monotonic()
    with pytest.raises(RuntimeError):
        picker._get_detail(7, deadline=time.monotonic() + 0.2)
    # The waiter gave up promptly; the owner's fetch is still gated.
    assert time.monotonic() - started < 2.0
    assert not results and not errors

    client.release.set()
    owner.join(timeout=5)
    assert errors == []
    assert len(results) == 1
    assert client.detail_calls == [7]  # still exactly one fetch
    # The finished fetch landed in the cache for everyone after.
    assert picker._get_detail(7) is results[0]
    assert client.detail_calls == [7]


def test_single_flight_shares_the_exception_and_cleans_up():
    client = _GatedDetailClient(details={7: NOT_FOUND})
    picker = make_picker(client)
    results: list = []
    errors: list = []

    threads = [
        threading.Thread(
            target=_call_in_thread,
            args=(lambda: picker._get_detail(7), results, errors),
        )
        for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    assert client.entered.wait(timeout=5)
    time.sleep(0.3)  # all four callers are on the one flight
    client.release.set()
    for thread in threads:
        thread.join(timeout=5)

    assert results == []
    assert len(errors) == 4
    # The verdict is shared verbatim: a 404 stays a 404 for waiters.
    assert all(isinstance(e, ResourceNotFoundError) for e in errors)
    assert client.detail_calls == [7]

    # The failed flight was cleaned up: a later caller retries the
    # fetch instead of joining a dead flight or reading a cached error.
    with pytest.raises(ResourceNotFoundError):
        picker._get_detail(7)
    assert client.detail_calls == [7, 7]


# --- Repeat fix: a restart must not re-serve page 1 ------------------------
# Regression test for the "same mangas again after refresh" bug, at
# picker level: two simulated process lifetimes, each with a FRESH
# pool and a FRESH recent-served store (a restart wipes both), over
# a scripted transport whose page 1 never changes. Pre-fix, both
# lifetimes' first batches came from page 1.


def _search_payload(ids, num_pages=5):
    return {
        "num_pages": num_pages,
        "result": [
            {
                "id": i,
                "english_title": f"Gallery {i}",
                "thumbnail": f"galleries/{i}/thumb.jpg",
            }
            for i in ids
        ],
    }


class PoolBackedClient:
    """The picker client interface over a REAL SearchPool.

    Only the detail/media seams are stubbed (the FakeClient
    pattern); draws come from the pool under test, so the batch
    below exercises the genuine cold-start path.
    """

    def __init__(self, pool):
        self._pool = pool

    def get_random_english_gallery(self, deadline=None, mode=None):
        return self._pool.next(mode=mode or FeedMode.RANDOM, deadline=deadline)

    def get_gallery_details(self, gallery_id, deadline=None):
        return make_detail(gallery_id)

    def build_media_url(self, relative_media_path, deadline=None):
        return f"https://cdn.example/{relative_media_path}"

    def build_gallery_url(self, gallery):
        gallery_id = gallery.id if isinstance(gallery, GallerySummary) else gallery
        return f"https://nhentai.net/g/{gallery_id}/"


def test_restart_lifetimes_never_open_with_page_one(fake_transport, monkeypatch):
    page_one = set(range(1, 26))  # the fixed newest/top-25 cluster
    for drawn_page, block in ((3, range(500, 525)), (4, range(600, 625))):
        monkeypatch.setattr(
            "src.pools.random.randint", lambda a, b, page=drawn_page: page
        )
        fake_transport.push_json(_search_payload(page_one, num_pages=5))
        fake_transport.push_json(_search_payload(block, num_pages=5))
        pool = SearchPool(JsonHttpClient(), low_water_mark=0)
        picker = make_picker(PoolBackedClient(pool), recent=RecentServedStore())
        batch = picker.batch(3)
        served = {item.id for item in batch.items}
        assert batch.errors == 0
        assert served <= set(block)
        assert not served & page_one
