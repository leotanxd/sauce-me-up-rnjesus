"""Package 4 — observability: metrics registry + instrumentation,
request IDs, async health, and startup warm-up.

The scripted-session tests pin the acceptance criterion: a known
sequence of operations moves exactly the expected counters.
"""

import inspect
import logging
import threading
import time

import pytest
from conftest import FakeClient, make_detail, make_picker
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from test_pools import StubHttp, search_payload

from sauce_me_up.app import create_app
from sauce_me_up.config import Settings
from sauce_me_up.metrics import Metrics
from sauce_me_up.middleware import RequestIdMiddleware
from sauce_me_up.routes.meta import create_meta_router
from sauce_me_up.routes.sauce import create_sauce_router
from sauce_me_up.upstream.client import NhentaiClient
from sauce_me_up.upstream.errors import ResourceNotFoundError
from sauce_me_up.upstream.http_client import JsonHttpClient
from sauce_me_up.upstream.pools import FeedMode, SearchPool


def counters(metrics: Metrics) -> dict:
    return metrics.snapshot()["counters"]


# --- The registry itself ---------------------------------------------------


def test_snapshot_shape_is_stable_from_boot():
    snap = Metrics().snapshot()
    assert snap["uptimeSeconds"] >= 0
    # The full fixed key set exists before anything happens.
    assert snap["counters"]["upstream.calls.search.2xx"] == 0
    assert snap["counters"]["upstream.calls.detail.network_error"] == 0
    assert snap["counters"]["picks.served"] == 0
    assert snap["batchDurationSeconds"] == {
        "count": 0,
        "sum": 0.0,
        "max": 0.0,
        "buckets": {
            "le_1s": 0,
            "le_5s": 0,
            "le_10s": 0,
            "le_20s": 0,
            "le_45s": 0,
            "over": 0,
        },
    }


def test_batch_duration_buckets_and_summary():
    metrics = Metrics()
    metrics.observe_batch_duration(0.5)
    metrics.observe_batch_duration(3.0)
    metrics.observe_batch_duration(60.0)
    summary = metrics.snapshot()["batchDurationSeconds"]
    assert summary["count"] == 3
    assert summary["sum"] == pytest.approx(63.5)
    assert summary["max"] == 60.0
    assert summary["buckets"]["le_1s"] == 1
    assert summary["buckets"]["le_5s"] == 1
    assert summary["buckets"]["over"] == 1


# --- Upstream instrumentation (JsonHttpClient) -----------------------------


def test_upstream_calls_counted_by_endpoint_and_status(fake_transport):
    metrics = Metrics()
    http = JsonHttpClient(metrics=metrics)
    fake_transport.push_json({"ok": True})
    http.get_json("https://nhentai.net/api/v2/search?query=x")
    fake_transport.push_json({"ok": True})
    http.get_json("https://nhentai.net/api/v2/galleries/42")
    fake_transport.push_json({"ok": True})
    http.get_json("https://nhentai.net/api/v2/cdn")
    assert counters(metrics)["upstream.calls.search.2xx"] == 1
    assert counters(metrics)["upstream.calls.detail.2xx"] == 1
    assert counters(metrics)["upstream.calls.cdn.2xx"] == 1


def test_429_counts_retries_rate_limit_and_cooldown(fake_transport):
    metrics = Metrics()
    http = JsonHttpClient(metrics=metrics)
    fake_transport.push_http(429, {"Retry-After": "5"})
    fake_transport.push_json({"ok": True})
    http.get_json("https://nhentai.net/api/v2/galleries/42")
    c = counters(metrics)
    assert c["upstream.calls.detail.4xx"] == 1
    assert c["upstream.calls.detail.2xx"] == 1
    assert c["upstream.retries"] == 1
    assert c["upstream.rate_limited"] == 1
    assert c["upstream.cooldown_activations"] == 1


def test_network_errors_counted_per_attempt(fake_transport):
    metrics = Metrics()
    http = JsonHttpClient(metrics=metrics)
    for _ in range(3):
        fake_transport.push_url_error()
    with pytest.raises(RuntimeError):
        http.get_json("https://nhentai.net/api/v2/search?query=x")
    c = counters(metrics)
    assert c["upstream.calls.search.network_error"] == 3
    assert c["upstream.retries"] == 2


def test_budget_exhaustion_is_counted(fake_transport):
    metrics = Metrics()
    # A near-zero refill rate (a None rate would disable the budget
    # entirely) with a burst of 1: one token exists, then it's gone.
    http = JsonHttpClient(metrics=metrics, budget_rate_per_minute=0.001, budget_burst=1)
    # Spend the single burst token directly, then the next real
    # call must fail fast on the empty bucket.
    http._consume_budget_token()
    with pytest.raises(RuntimeError, match="budget exhausted"):
        http.get_json("https://nhentai.net/api/v2/cdn")
    assert counters(metrics)["upstream.budget_exhausted"] == 1
    assert fake_transport.calls == []  # fail fast: nothing was sent


# --- Picker instrumentation: the scripted session --------------------------


def _session_app(metrics: Metrics):
    """A real picker (FakeClient upstream) behind the real routers."""
    client = FakeClient(draws=[11, 12, 13])
    picker = make_picker(client, metrics=metrics)
    app = FastAPI()
    app.add_middleware(RequestIdMiddleware)
    app.include_router(create_sauce_router(picker))
    app.include_router(create_meta_router(metrics_provider=metrics.snapshot))
    return TestClient(app, raise_server_exceptions=False)


def test_scripted_session_moves_exactly_the_expected_counters():
    metrics = Metrics()
    client = _session_app(metrics)

    # 2 batches (2 + 1 across a mode switch), then 3 page fetches
    # for an already-served gallery.
    assert client.get("/api/sauce/batch?n=2").status_code == 200
    assert client.get("/api/sauce/batch?n=1&mode=popular").status_code == 200
    for _ in range(3):
        assert client.get("/api/sauce/11/pages").status_code == 200

    c = counters(metrics)
    assert c["picks.served"] == 3
    assert c["picks.rerolled"] == 0
    assert c["picks.fallback"] == 0
    assert c["picks.error"] == 0
    # Each pick fetched its detail once (miss); the 3 page fetches
    # for gallery 11 were served from the detail cache (hits).
    assert c["detail_cache.misses"] == 3
    assert c["detail_cache.hits"] == 3
    summary = metrics.snapshot()["batchDurationSeconds"]
    assert summary["count"] == 2  # the two batch calls, not /pages

    # And the endpoint serves the same snapshot.
    body = client.get("/api/metrics").json()
    assert body["counters"]["picks.served"] == 3
    assert body["batchDurationSeconds"]["count"] == 2


def test_pick_outcomes_reroll_fallback_and_error():
    metrics = Metrics()
    client = FakeClient(
        draws=[21, 22],
        details={21: make_detail(21, languages=("japanese",))},
    )
    picker = make_picker(client, metrics=metrics)
    picker.next()  # 21 is not English -> re-roll; 22 serves
    c = counters(metrics)
    assert c["picks.rerolled"] == 1
    assert c["picks.served"] == 1

    metrics2 = Metrics()
    failing = FakeClient(
        draws=[31, 32],
        details={
            31: RuntimeError("transient"),
            32: RuntimeError("transient"),
        },
    )
    picker2 = make_picker(failing, metrics=metrics2)
    # Both candidates fail transiently; further draws exhaust the
    # queue (draw failure -> 502 path)... the first transient
    # candidate is kept as fallback, but the draw-queue exhaustion
    # raises before the fallback can serve. Pin the re-rolls.
    with pytest.raises(HTTPException):
        picker2.next()
    c2 = counters(metrics2)
    assert c2["picks.rerolled"] == 2

    metrics3 = Metrics()
    dead = FakeClient(draws=[RuntimeError("upstream down")])
    picker3 = make_picker(dead, metrics=metrics3)
    with pytest.raises(HTTPException):
        picker3.next()
    assert counters(metrics3)["picks.error"] == 1


def test_fallback_serve_is_counted():
    metrics = Metrics()
    # Eight attempts, every detail transiently failing: the pick
    # falls back to serving the first candidate unverified.
    draws = list(range(41, 49))
    details = {gid: RuntimeError("transient") for gid in draws}
    picker = make_picker(FakeClient(draws=draws, details=details), metrics=metrics)
    picker.next()
    c = counters(metrics)
    assert c["picks.fallback"] == 1
    assert c["picks.served"] == 0
    assert c["picks.rerolled"] == 8


# --- Pool refill instrumentation --------------------------------------------


def test_pool_refills_counted_per_mode():
    metrics = Metrics()
    stub = StubHttp(lambda url, number: search_payload([100 + number]))
    pool = SearchPool(stub, low_water_mark=0, metrics=metrics)
    pool.next(mode=FeedMode.RANDOM)
    pool.next(mode=FeedMode.POPULAR)
    c = counters(metrics)
    assert c["pool.refills.random"] == 1
    assert c["pool.refills.popular"] == 1
    assert c["pool.background_refills.random"] == 0


# --- Request IDs -------------------------------------------------------------


def test_request_id_minted_and_echoed():
    client = _session_app(Metrics())
    response = client.get("/api/metrics")
    request_id = response.headers.get("x-request-id")
    assert request_id and len(request_id) == 32  # uuid4 hex


def test_request_id_propagated_from_the_caller():
    client = _session_app(Metrics())
    response = client.get("/api/metrics", headers={"X-Request-ID": "leo-test-123"})
    assert response.headers["x-request-id"] == "leo-test-123"


def test_log_lines_carry_the_response_request_id(caplog):
    metrics = Metrics()
    # Gallery 51's detail 404s (a warning is logged), 52 serves.
    client = FakeClient(
        draws=[51, 52],
        details={51: ResourceNotFoundError("not here")},
    )
    picker = make_picker(client, metrics=metrics)
    app = FastAPI()
    app.add_middleware(RequestIdMiddleware)
    app.include_router(create_sauce_router(picker))
    app.include_router(create_meta_router())
    test_client = TestClient(app, raise_server_exceptions=False)

    with caplog.at_level(logging.WARNING, logger="sauce_me_up.picker"):
        response = test_client.get("/api/sauce/next")
    assert response.status_code == 200
    request_id = response.headers["x-request-id"]
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "the 404 re-roll should have logged a warning"
    for record in warnings:
        assert record.request_id == request_id
        assert f"[request_id={request_id}]" in record.getMessage()


# --- Health: async + responsive under load -----------------------------------


def test_health_handler_is_async():
    router = create_meta_router()
    health_route = next(r for r in router.routes if r.path == "/api/health")
    assert inspect.iscoroutinefunction(health_route.endpoint)


class _BlockingPicker:
    """A picker whose batch blocks until released (a slow batch)."""

    def __init__(self):
        self.release = threading.Event()
        self.entered = threading.Event()

    def batch(self, n, mode=FeedMode.RANDOM):
        from sauce_me_up.schemas import BatchOut

        self.entered.set()
        assert self.release.wait(timeout=10)
        return BatchOut(items=[], errors=0)

    def next(self, mode=FeedMode.RANDOM, deadline=None):  # pragma: no cover
        raise AssertionError("not used")

    def pages(self, gallery_id):  # pragma: no cover
        raise AssertionError("not used")


def test_health_answers_while_a_batch_is_in_flight():
    picker = _BlockingPicker()
    app = FastAPI()
    app.include_router(create_sauce_router(picker))
    app.include_router(create_meta_router())
    client = TestClient(app, raise_server_exceptions=False)
    # A second client for the concurrent batch: one TestClient is
    # not driven from two threads at once.
    batch_client = TestClient(app, raise_server_exceptions=False)

    batch_thread = threading.Thread(
        target=lambda: batch_client.get("/api/sauce/batch?n=1"), daemon=True
    )
    batch_thread.start()
    assert picker.entered.wait(timeout=5)  # the batch is now stuck

    started = time.monotonic()
    response = client.get("/api/health")
    elapsed = time.monotonic() - started
    picker.release.set()
    batch_thread.join(timeout=5)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    # The design target is <50 ms (the handler only reads observed
    # state on the event loop); the bound here is deliberately
    # generous so the test pins responsiveness, not scheduler luck.
    assert elapsed < 2.0


# --- Metrics endpoint gating ---------------------------------------------------


def test_metrics_route_absent_without_a_provider():
    app = FastAPI()
    app.include_router(create_meta_router())
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/metrics").status_code == 404


def test_create_app_metrics_disabled_drops_the_endpoint():
    app = create_app(Settings(metrics_enabled=False))
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/metrics").status_code == 404
    assert client.get("/api/health").status_code == 200


# --- Startup warm-up -----------------------------------------------------------


def test_warm_up_primes_pools_and_cdn_config(fake_transport, search_page):
    cdn_payload = {
        "image_servers": ["https://i.example"],
        "thumb_servers": ["https://t.example"],
    }
    # Per mode the warm-up refill is TWO search calls since the
    # repeat fix: a learning fetch (its page is discarded) plus the
    # random page that actually pools.
    fake_transport.push_json(search_page)  # random: learning fetch
    fake_transport.push_json(search_page)  # random: pooled page
    fake_transport.push_json(search_page)  # popular: learning fetch
    fake_transport.push_json(search_page)  # popular: pooled page
    fake_transport.push_json(cdn_payload)  # CDN config

    # low_water_mark=0: the fixture page holds 3 items, below the
    # production mark of 5 — background refills would consume the
    # scripted outcomes out of order (they have their own tests).
    http = JsonHttpClient()
    client = NhentaiClient(http=http, pool=SearchPool(http, low_water_mark=0))
    client.warm_up(deadline=time.monotonic() + 10)
    assert len(fake_transport.calls) == 5

    # The first real draws now cost ZERO search fetches: both pools
    # are already warm.
    client.get_random_english_gallery(mode=FeedMode.RANDOM)
    client.get_random_english_gallery(mode=FeedMode.POPULAR)
    search_calls = [u for u in fake_transport.calls if "/search" in u]
    assert len(search_calls) == 4  # only the warm-up's own refills


def test_create_app_returns_immediately_with_a_dead_upstream(fake_transport):
    # Every upstream attempt fails at the connection level; warm-up
    # must fail in its thread, never blocking or breaking boot.
    for _ in range(30):
        fake_transport.push_url_error()

    started = time.monotonic()
    app = create_app()
    assert time.monotonic() - started < 2.0  # boot did not wait

    app.state.warm_up_thread.join(timeout=10)
    assert not app.state.warm_up_thread.is_alive()
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/health").status_code == 200
