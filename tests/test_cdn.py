"""MediaUrlBuilder: deterministic host choice + bounded config refresh."""

import pytest

from src.cdn import MediaUrlBuilder
from src.http_client import JsonHttpClient

CONFIG = {
    "image_servers": [
        "https://i1.example",
        "https://i2.example",
        "https://i3.example",
    ],
    "thumb_servers": ["https://t1.example", "https://t2.example"],
}

PAGE_PATH = "galleries/123/1.jpg"
THUMB_PATH = "galleries/123/thumb.jpg"


class _FakeClock:
    def __init__(self, start: float = 1000.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_builder(fake_transport, **kwargs):
    return MediaUrlBuilder(JsonHttpClient(), **kwargs)


def test_same_path_same_host_across_100_calls(fake_transport):
    fake_transport.push_json(CONFIG)
    builder = make_builder(fake_transport)
    urls = {builder.url_for(PAGE_PATH) for _ in range(100)}
    assert len(urls) == 1  # one path -> one host, every time
    url = urls.pop()
    assert url.endswith(f"/{PAGE_PATH}")
    assert url.split("/")[2] in {"i1.example", "i2.example", "i3.example"}
    assert len(fake_transport.calls) == 1  # config fetched once


def test_config_fetched_once_within_ttl_under_load(fake_transport):
    fake_transport.push_json(CONFIG)
    builder = make_builder(fake_transport)
    for n in range(50):
        builder.url_for(f"galleries/{n}/1.jpg")
    assert len(fake_transport.calls) == 1


def test_thumbnail_paths_use_thumb_servers(fake_transport):
    fake_transport.push_json(CONFIG)
    builder = make_builder(fake_transport)
    urls = {builder.url_for(THUMB_PATH) for _ in range(20)}
    assert len(urls) == 1
    assert urls.pop().split("/")[2] in {"t1.example", "t2.example"}


def test_config_refreshes_after_ttl_and_host_stays_stable(fake_transport):
    clock = _FakeClock()
    fake_transport.push_json(CONFIG)
    fake_transport.push_json(CONFIG)  # the refresh, same server list
    builder = make_builder(fake_transport, config_ttl_seconds=100.0, clock=clock)
    before = builder.url_for(PAGE_PATH)
    assert len(fake_transport.calls) == 1

    clock.advance(99)  # still within the TTL: no refetch
    assert builder.url_for(PAGE_PATH) == before
    assert len(fake_transport.calls) == 1

    clock.advance(2)  # past the TTL: exactly one refresh...
    assert builder.url_for(PAGE_PATH) == before  # ...and the same host
    assert len(fake_transport.calls) == 2


def test_failed_refresh_serves_the_stale_config(fake_transport):
    clock = _FakeClock()
    fake_transport.push_json(CONFIG)
    builder = make_builder(fake_transport, config_ttl_seconds=100.0, clock=clock)
    before = builder.url_for(PAGE_PATH)

    clock.advance(101)  # TTL expired; the refresh attempt fails
    for _ in range(3):  # one get_json call = up to 3 transport attempts
        fake_transport.push_url_error()
    assert builder.url_for(PAGE_PATH) == before  # stale config served
    assert len(fake_transport.calls) == 4


def test_first_fetch_failure_propagates(fake_transport):
    builder = make_builder(fake_transport)
    for _ in range(3):
        fake_transport.push_url_error()
    with pytest.raises(RuntimeError):
        builder.url_for(PAGE_PATH)
