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

