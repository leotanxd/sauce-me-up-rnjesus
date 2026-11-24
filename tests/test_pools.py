"""SearchPool: drain-before-refetch, per-mode pools, page fallback."""

from src.http_client import JsonHttpClient
from src.pools import FeedMode, SearchPool


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


def make_pool(fake_urlopen):
    return SearchPool(JsonHttpClient())


def test_pool_drains_a_page_before_refetching(fake_urlopen):
    ids = list(range(1000, 1025))  # one full 25-item page
    fake_urlopen.push_json(search_payload(ids))
    pool = make_pool(fake_urlopen)

    served = {pool.next().id for _ in range(25)}
    assert served == set(ids)
    assert len(fake_urlopen.calls) == 1  # one search served all 25 picks

    fake_urlopen.push_json(search_payload([2000]))
    assert pool.next().id == 2000
    assert len(fake_urlopen.calls) == 2  # refetch only once drained


def test_empty_random_page_falls_back_to_page_one(fake_urlopen):
    fake_urlopen.push_json(search_payload([1], num_pages=3))
    pool = make_pool(fake_urlopen)
    assert pool.next().id == 1
    assert len(fake_urlopen.calls) == 1

    # Refill: the random page comes back empty, page 1 is the fallback.
    fake_urlopen.push_json({"num_pages": 3, "result": []})
    fake_urlopen.push_json(search_payload([2], num_pages=3))
    assert pool.next().id == 2
    assert len(fake_urlopen.calls) == 3
    assert "page=1" in fake_urlopen.calls[-1]


def test_modes_have_independent_pools_and_sorts(fake_urlopen):
    fake_urlopen.push_json(search_payload([10]))
    fake_urlopen.push_json(search_payload([20]))
    pool = make_pool(fake_urlopen)

    assert pool.next(mode=FeedMode.RANDOM).id == 10
    assert pool.next(mode=FeedMode.POPULAR).id == 20
    random_url, popular_url = fake_urlopen.calls
    assert "sort=" not in random_url
    assert "sort=popular-week" in popular_url


def test_items_with_unusable_ids_are_dropped_at_parse(fake_urlopen):
    payload = {
        "num_pages": 1,
        "result": [
            {"english_title": "no id at all"},
            {"id": "not-an-int", "english_title": "bad id"},
            {"id": 7, "english_title": "usable", "thumbnail": "g/7/thumb.jpg"},
        ],
    }
    fake_urlopen.push_json(payload)
    pool = make_pool(fake_urlopen)
    assert pool.next().id == 7
    assert len(fake_urlopen.calls) == 1
