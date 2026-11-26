"""RecentServedStore / DetailCache semantics, including under threads."""

import threading

from backend.stores import DetailCache, RecentServedStore


def test_remember_and_contains():
    store = RecentServedStore()
    assert 1 not in store
    store.remember(1)
    assert 1 in store


def test_duplicate_remember_is_a_noop():
    store = RecentServedStore()
    store.remember(1)
    store.remember(1)
    assert list(store._ids) == [1]
    assert store._set == {1}


def test_eviction_drops_the_oldest_from_both_structures():
    store = RecentServedStore(maxlen=3)
    for gallery_id in (1, 2, 3, 4):
        store.remember(gallery_id)
    assert 1 not in store
    assert {2, 3, 4} <= store._set
    assert set(store._ids) == store._set


def test_detail_cache_hit_before_ttl_and_miss_after():
    now = [1000.0]
    cache = DetailCache(ttl_seconds=300.0, clock=lambda: now[0])
    cache.put(1, "detail")
    now[0] += 299
    assert cache.get(1) == "detail"
    now[0] += 2
    assert cache.get(1) is None


def test_detail_cache_put_at_capacity_evicts_only_the_oldest():
    # Package 3 LRU semantics (replaces the old clear-all behaviour):
    # a put into a full cache evicts the single oldest entry; the
    # recently-stored entries survive.
    now = [0.0]
    cache = DetailCache(max_entries=2, clock=lambda: now[0])
    cache.put(1, "a")
    now[0] += 1
    cache.put(2, "b")
    now[0] += 1
    cache.put(3, "c")
    assert cache.get(1) is None
    assert cache.get(2) == "b"
    assert cache.get(3) == "c"


def test_detail_cache_reput_refreshes_the_eviction_order():
    now = [0.0]
    cache = DetailCache(max_entries=2, clock=lambda: now[0])
    cache.put(1, "a")
    now[0] += 1
    cache.put(2, "b")
    now[0] += 1
    cache.put(1, "a2")  # re-storing 1 makes 2 the oldest entry
    now[0] += 1
    cache.put(3, "c")
    assert cache.get(1) == "a2"
    assert cache.get(2) is None
    assert cache.get(3) == "c"


def test_forget_releases_a_reservation():
    store = RecentServedStore()
    store.remember(1)
    store.forget(1)
    assert 1 not in store
    assert list(store._ids) == []
    assert store._set == set()


def test_forget_of_unknown_id_is_a_noop():
    store = RecentServedStore()
    store.remember(1)
    store.forget(999)
    assert 1 in store


def test_recent_store_threaded_hammer_stays_consistent():
    store = RecentServedStore(maxlen=300)
    errors = []

    def hammer(offset):
        try:
            for i in range(200):
                gallery_id = offset + (i % 50)
                store.remember(gallery_id)
                _ = gallery_id in store
        except Exception as error:  # pragma: no cover - failure path
            errors.append(error)

    threads = [threading.Thread(target=hammer, args=(n * 1000,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert set(store._ids) == store._set
    assert len(store._ids) == len(store._set)
    assert len(store._ids) <= 300
