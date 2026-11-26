"""SearchPool: drain-before-refetch, per-mode pools, page fallback."""

import threading
import time

from sauce_me_up.upstream.http_client import JsonHttpClient
from sauce_me_up.upstream.pools import FeedMode, SearchPool


def search_payload(ids, num_pages=5):
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


def make_pool(fake_transport):
    # low_water_mark=0: these tests pin the drain/fallback semantics;
    # background refills are covered by the dedicated tests below
    # (a background thread would race the scripted call counts here).
    return SearchPool(JsonHttpClient(), low_water_mark=0)


def test_pool_drains_a_page_before_refetching(fake_transport):
    ids = list(range(1000, 1025))  # one full 25-item page
    # num_pages=1: a single-page catalogue pools its learning fetch
    # directly, so this test pins drain/refetch only — the multi-page
    # cold start (learn, discard, random page) has its own tests below.
    fake_transport.push_json(search_payload(ids, num_pages=1))
    pool = make_pool(fake_transport)

    served = {pool.next().id for _ in range(25)}
    assert served == set(ids)
    assert len(fake_transport.calls) == 1  # one search served all 25 picks

    fake_transport.push_json(search_payload([2000]))
    assert pool.next().id == 2000
    assert len(fake_transport.calls) == 2  # refetch only once drained


def test_empty_random_page_falls_back_to_page_one(fake_transport, monkeypatch):
    # Pin the page draws: every random draw is page 2 (and the F2
    # retry draw therefore lands on page 3).
    monkeypatch.setattr("sauce_me_up.upstream.pools.random.randint", lambda a, b: 2)
    # Cold start: the learning fetch (page 1) is discarded and the
    # random page (page 2) is pooled instead.
    fake_transport.push_json(search_payload([900], num_pages=3))
    fake_transport.push_json(search_payload([1], num_pages=3))
    pool = make_pool(fake_transport)
    assert pool.next().id == 1
    assert len(fake_transport.calls) == 2

    # Refill: the random page AND the second random page both come
    # back empty — only then is page 1 the fallback.
    fake_transport.push_json({"num_pages": 3, "result": []})
    fake_transport.push_json({"num_pages": 3, "result": []})
    fake_transport.push_json(search_payload([2], num_pages=3))
    assert pool.next().id == 2
    assert len(fake_transport.calls) == 5
    assert "page=1" in fake_transport.calls[-1]


def test_modes_have_independent_pools_and_sorts(fake_transport):
    # num_pages=1 per mode: each mode's learning fetch is its pool,
    # so the two draws cost exactly one call each.
    fake_transport.push_json(search_payload([10], num_pages=1))
    fake_transport.push_json(search_payload([20], num_pages=1))
    pool = make_pool(fake_transport)

    assert pool.next(mode=FeedMode.RANDOM).id == 10
    assert pool.next(mode=FeedMode.POPULAR).id == 20
    random_url, popular_url = fake_transport.calls
    assert "sort=" not in random_url
    assert "sort=popular-week" in popular_url


# --- Repeat fix: cold start must not serve page 1 -------------------------
# Regression tests for the "same mangas again after refresh" bug: a
# fresh process pooled upstream page 1 (the newest ~25 / top ~25) on
# every start, and a restart wiped the no-repeat window at the same
# moment — so the same cluster came back after every restart.


def test_cold_start_learns_num_pages_then_pools_a_random_page(
    fake_transport, monkeypatch
):
    # The headline regression test: page 1 is IDs 1-25 and the drawn
    # random page (3) is IDs 500-524. A fresh pool must serve from
    # the random page — pre-fix it served page 1, deterministically.
    monkeypatch.setattr("sauce_me_up.upstream.pools.random.randint", lambda a, b: 3)
    fake_transport.push_json(search_payload(range(1, 26), num_pages=5))
    fake_transport.push_json(search_payload(range(500, 525), num_pages=5))
    pool = make_pool(fake_transport)

    assert pool.next().id in range(500, 525)
    assert len(fake_transport.calls) == 2  # learning fetch + random page
    assert "page=1" in fake_transport.calls[0]  # page 1 teaches num_pages
    assert "page=3" in fake_transport.calls[1]  # ...but is never pooled


def test_cold_start_single_page_catalogue_pools_page_one(fake_transport):
    fake_transport.push_json(search_payload([42], num_pages=1))
    pool = make_pool(fake_transport)
    assert pool.next().id == 42
    assert len(fake_transport.calls) == 1  # no wasteful second fetch


def test_cold_start_invalid_num_pages_serves_the_learning_page(fake_transport):
    # Missing / zero / non-integer num_pages all collapse to "one
    # page": the learning payload is served, exactly as before.
    payloads = [
        {"result": search_payload([11])["result"]},
        search_payload([12], num_pages=0),
        search_payload([13], num_pages="five"),
    ]
    for payload, expected in zip(payloads, (11, 12, 13), strict=True):
        fake_transport.push_json(payload)
        pool = make_pool(fake_transport)
        assert pool.next().id == expected
    assert len(fake_transport.calls) == 3  # one learning fetch each


def test_empty_random_page_tries_a_second_random_page_before_page_one(
    fake_transport, monkeypatch
):
    # Pin the draws: random pages are 2, then (the different retry) 3.
    monkeypatch.setattr("sauce_me_up.upstream.pools.random.randint", lambda a, b: 2)
    fake_transport.push_json(search_payload([900], num_pages=3))  # learning
    fake_transport.push_json(search_payload([1], num_pages=3))  # page 2
    pool = make_pool(fake_transport)
    assert pool.next().id == 1  # cold pool drained; mode is warm now

    fake_transport.push_json({"num_pages": 3, "result": []})  # page 2: empty
    fake_transport.push_json(search_payload([7], num_pages=3))  # page 3: served
    assert pool.next().id == 7
    assert "page=3" in fake_transport.calls[-1]
    # Page 1 was fetched exactly once — the cold-start learning call.
    assert sum("page=1" in call for call in fake_transport.calls) == 1


def test_items_with_unusable_ids_are_dropped_at_parse(fake_transport):
    payload = {
        "num_pages": 1,
        "result": [
            {"english_title": "no id at all"},
            {"id": "not-an-int", "english_title": "bad id"},
            {"id": 7, "english_title": "usable", "thumbnail": "g/7/thumb.jpg"},
        ],
    }
    fake_transport.push_json(payload)
    pool = make_pool(fake_transport)
    assert pool.next().id == 7
    assert len(fake_transport.calls) == 1


# --- Package 3: refill out of the lock + low-water background refill -------
# These use a stub get_json client (SearchPool only needs that one
# method) so fetches can be gated on events deterministically.


class StubHttp:
    """get_json stand-in: handler(url, call_number) -> payload."""

    def __init__(self, handler):
        self._handler = handler
        self.calls: list[str] = []
        self._lock = threading.Lock()

    def get_json(self, url, deadline=None):
        with self._lock:
            self.calls.append(url)
            number = len(self.calls)
        return self._handler(url, number)


def test_other_mode_draws_while_one_mode_refills():
    entered = threading.Event()
    release = threading.Event()

    def handler(url, number):
        if "sort=popular-week" in url:
            return search_payload([20], num_pages=1)
        entered.set()
        assert release.wait(timeout=5)
        return search_payload([10], num_pages=1)

    pool = SearchPool(StubHttp(handler), low_water_mark=0)
    drawn = []
    thread = threading.Thread(
        target=lambda: drawn.append(pool.next(mode=FeedMode.RANDOM).id)
    )
    thread.start()
    assert entered.wait(timeout=5)  # the RANDOM refill is in flight

    # POPULAR has its own lock and pool: its draw must not wait for
    # the RANDOM mode's network fetch.
    assert pool.next(mode=FeedMode.POPULAR).id == 20

    release.set()
    thread.join(timeout=5)
    assert drawn == [10]


def test_low_water_triggers_exactly_one_background_refill():
    gate = threading.Event()

    def handler(url, number):
        if number == 2:
            assert gate.wait(timeout=5)  # hold the background refill open
        # num_pages=1: the cold start pools call 1's payload directly,
        # keeping the call numbers aligned with the refill sequence.
        return search_payload([number * 100 + i for i in range(1, 5)], num_pages=1)

    stub = StubHttp(handler)
    pool = SearchPool(stub, low_water_mark=3)

    assert pool.next().id in range(101, 105)  # sync refill: call 1, 3 left
    pool.next()  # 2 left: below the mark -> background refill starts
    pool.next()  # 1 left: already refilling, no second fetch
    pool.next()  # 0 left: still refilling, no third fetch
    assert len(stub.calls) == 2  # exactly one background refill

    gate.set()
    # The pool is empty and the refill is in flight: this draw waits
    # for it to land, then serves from the new page (3 left after).
    assert pool.next().id in range(201, 205)
    assert len(stub.calls) == 2

    pool.next()  # 2 left: below the mark again -> one more refill
    deadline = time.monotonic() + 5
    while len(stub.calls) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(stub.calls) == 3


def test_background_refill_failure_leaves_pool_usable():
    gate = threading.Event()

    def handler(url, number):
        if number == 2:
            assert gate.wait(timeout=5)
            raise RuntimeError("upstream down")
        return search_payload([number * 100 + i for i in range(1, 5)], num_pages=1)

    stub = StubHttp(handler)
    pool = SearchPool(stub, low_water_mark=3)

    pool.next()  # sync refill: call 1, 3 left
    pool.next()  # 2 left: background refill starts (and will fail)
    pool.next()  # drain while it is in flight
    pool.next()  # pool empty, refill still marked in flight
    gate.set()  # the background refill now fails and clears its mark

    # The next draw falls back to a synchronous refill and serves.
    assert pool.next().id in range(301, 305)
    assert len(stub.calls) == 3
