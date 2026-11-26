"""SaucePicker policy: verification, re-rolls, no-repeat, accounting."""

import threading
import time

import pytest
from fastapi import HTTPException

from backend.config import Settings
from backend.stores import RecentServedStore
from conftest import FakeClient, make_detail, make_picker
from src.errors import ResourceNotFoundError

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
    client = FakeClient(
        draws=[1, 2] * 4, details={1: TRANSIENT, 2: TRANSIENT}
    )
    picker = make_picker(client)
    item = picker.next()
    assert item.id == 1  # the first transient failure, as the fallback
    assert item.page_count is None  # unverified: no detail, no count


def test_all_404_raises_502_and_remembers_nothing():
    recent = RecentServedStore()
    client = FakeClient(
        draws=[1, 2] * 4, details={1: NOT_FOUND, 2: NOT_FOUND}
    )
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
    client = FakeClient(
        draws=[1, 2] * 8, details={1: NOT_FOUND, 2: NOT_FOUND}
    )
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
    picker = make_picker(
        FakeClient(media_fail_paths={"galleries/5/2.jpg"})
    )
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
    picker = make_picker(
        client, settings=Settings(batch_budget_seconds=0.0)
    )
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
