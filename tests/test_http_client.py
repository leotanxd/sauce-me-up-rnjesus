"""JsonHttpClient: retries, status mapping, deadlines — all offline."""

import gzip
import json
import time

import httpx
import pytest

from src.errors import ResourceNotFoundError
from src.http_client import JsonHttpClient

URL = "https://nhentai.net/api/v2/search?query=language:english&page=1"


@pytest.fixture
def client():
    return JsonHttpClient()


def test_success_returns_parsed_json(client, fake_transport):
    fake_transport.push_json({"num_pages": 3, "result": []})
    assert client.get_json(URL) == {"num_pages": 3, "result": []}
    assert fake_transport.calls == [URL]


def test_404_raises_not_found_without_retry(client, fake_transport):
    fake_transport.push_http(404)
    with pytest.raises(ResourceNotFoundError):
        client.get_json(URL)
    assert len(fake_transport.calls) == 1


@pytest.mark.parametrize("status", [401, 403])
def test_auth_statuses_raise_without_retry(client, fake_transport, status):
    fake_transport.push_http(status)
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_transport.calls) == 1


def test_429_retried_and_retry_after_is_the_sleep_floor(client, fake_transport):
    fake_transport.push_http(429, {"Retry-After": "7"})
    fake_transport.push_json({"ok": True})
    assert client.get_json(URL) == {"ok": True}
    assert len(fake_transport.calls) == 2
    # Backoff alone would be 2s + up to 1s jitter; Retry-After wins.
    assert fake_transport.sleeps == [7.0]


def test_500_exhausts_exactly_three_attempts(client, fake_transport):
    for _ in range(3):
        fake_transport.push_http(500)
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_transport.calls) == 3
    assert len(fake_transport.sleeps) == 2  # no sleep after the last attempt


def test_url_error_is_retried(client, fake_transport):
    fake_transport.push_url_error()
    fake_transport.push_json({"ok": True})
    assert client.get_json(URL) == {"ok": True}
    assert len(fake_transport.calls) == 2


def test_deadline_already_passed_fails_before_any_request(client, fake_transport):
    with pytest.raises(RuntimeError):
        client.get_json(URL, deadline=time.monotonic() - 1)
    assert fake_transport.calls == []


def test_deadline_expiring_mid_backoff_raises_instead_of_sleeping(
    client, fake_transport
):
    fake_transport.push_http(429)  # backoff would be >= 2s
    fake_transport.push_json({"ok": True})
    with pytest.raises(RuntimeError):
        client.get_json(URL, deadline=time.monotonic() + 0.5)
    assert fake_transport.sleeps == []  # never slept past the deadline


def test_malformed_json_raises(client, fake_transport):
    fake_transport.push_raw(b"this is not json{")
    with pytest.raises(RuntimeError):
        client.get_json(URL)


def test_last_success_at_recorded_on_success_only(client, fake_transport):
    assert client.last_success_at is None
    fake_transport.push_http(404)
    with pytest.raises(ResourceNotFoundError):
        client.get_json(URL)
    assert client.last_success_at is None  # failures don't count

    fake_transport.push_json({"ok": True})
    before = time.time()
    client.get_json(URL)
    assert client.last_success_at is not None
    assert before <= client.last_success_at <= time.time()


# --- Package 2: shared cooldown + global request budget -------------------
# The cooldown/budget clock is injectable precisely so these tests can
# advance time by hand instead of sleeping.


class _FakeClock:
    def __init__(self, start: float = 1000.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_429_storm_sets_a_cooldown_new_calls_fail_fast_in(fake_transport):
    clock = _FakeClock()
    client = JsonHttpClient(clock=clock)
    for _ in range(3):
        fake_transport.push_http(429, {"Retry-After": "30"})
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_transport.calls) == 3  # the storm call used its retries
    assert client.cooldown_until() is not None

    # Inside the window a new call spends NO request at all.
    fake_transport.push_json({"ok": True})
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_transport.calls) == 3

    # After the window (Retry-After was 30s) calls flow again.
    clock.advance(31)
    assert client.cooldown_until() is None
    assert client.get_json(URL) == {"ok": True}
    assert len(fake_transport.calls) == 4


def test_cooldown_uses_the_configured_floor_without_retry_after(fake_transport):
    clock = _FakeClock()
    client = JsonHttpClient(clock=clock, cooldown_default_seconds=42.0)
    for _ in range(3):
        fake_transport.push_http(429)  # no Retry-After header at all
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    until = client.cooldown_until()
    assert until is not None
    # Floor is 42s: still cooling at +20s of clock time...
    clock.advance(20)
    assert client.cooldown_until() is not None
    # ...and clear once past it (backoff alone is < 10s, so only the
    # floor can explain the window's length).
    clock.advance(30)
    assert client.cooldown_until() is None


def test_403_sets_the_long_forbidden_cooldown(fake_transport):
    clock = _FakeClock()
    client = JsonHttpClient(clock=clock, forbidden_cooldown_seconds=300.0)
    fake_transport.push_http(403)
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    until = client.cooldown_until()
    assert until is not None
    assert time.time() + 250 < until < time.time() + 310

    fake_transport.push_json({"ok": True})
    with pytest.raises(RuntimeError):
        client.get_json(URL)  # fail fast, no request spent
    assert len(fake_transport.calls) == 1

    clock.advance(301)
    assert client.get_json(URL) == {"ok": True}


def test_500_storm_does_not_set_a_cooldown(client, fake_transport):
    # 5xx is retried per-call as before, but it is not a rate-limit
    # signal: no shared cooldown follows from it.
    for _ in range(3):
        fake_transport.push_http(500)
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert client.cooldown_until() is None
    fake_transport.push_json({"ok": True})
    assert client.get_json(URL) == {"ok": True}


def test_budget_bounds_requests_and_refills_over_time(fake_transport):
    clock = _FakeClock()
    client = JsonHttpClient(
        clock=clock, budget_rate_per_minute=60.0, budget_burst=2
    )
    for n in (1, 2, 3):
        fake_transport.push_json({"n": n})
    assert client.get_json(URL) == {"n": 1}
    assert client.get_json(URL) == {"n": 2}
    with pytest.raises(RuntimeError):
        client.get_json(URL)  # burst spent: fail fast
    assert len(fake_transport.calls) == 2  # refused before any request

    clock.advance(1.0)  # 60/min refills exactly one token per second
    assert client.get_json(URL) == {"n": 3}
    assert len(fake_transport.calls) == 3


def test_budget_counts_retries_as_requests(fake_transport):
    clock = _FakeClock()
    client = JsonHttpClient(
        clock=clock, budget_rate_per_minute=60.0, budget_burst=2
    )
    fake_transport.push_http(500)
    fake_transport.push_http(500)
    fake_transport.push_json({"ok": True})
    # Two attempts spend the whole burst; the third attempt of the
    # SAME call is refused by the budget, not by the upstream.
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_transport.calls) == 2


def test_budget_can_be_disabled_with_no_rate(fake_transport):
    client = JsonHttpClient(budget_rate_per_minute=None, budget_burst=1)
    for _ in range(3):
        fake_transport.push_json({"ok": True})
        assert client.get_json(URL) == {"ok": True}
    assert len(fake_transport.calls) == 3


# --- Package 3: pooled httpx transport ------------------------------------
# These exercise the REAL default transport with only the wire itself
# stubbed (httpx.Client.get), so pooling and gzip decoding are the
# production code paths, not the scripted fake's.


def _stub_wire(monkeypatch, responder):
    """Patch httpx.Client.get; record (client id, headers) per call."""
    seen = []

    def fake_get(self, url, headers=None, timeout=None):
        seen.append((id(self), headers))
        return responder(url)

    monkeypatch.setattr(httpx.Client, "get", fake_get)
    return seen


def test_default_transport_reuses_one_pooled_client(monkeypatch):
    def responder(url):
        request = httpx.Request("GET", url)
        return httpx.Response(200, json={"ok": True}, request=request)

    seen = _stub_wire(monkeypatch, responder)
    client = JsonHttpClient()
    assert client.get_json(URL) == {"ok": True}
    assert client.get_json(URL) == {"ok": True}

    # Both calls went through ONE httpx.Client instance — the pool —
    # not a fresh client (and fresh handshake) per request.
    assert len({client_id for client_id, _ in seen}) == 1
    # Compression is part of the request contract.
    assert all(h["Accept-Encoding"] == "gzip" for _, h in seen)


def test_gzipped_upstream_body_is_decoded(monkeypatch):
    def responder(url):
        request = httpx.Request("GET", url)
        body = gzip.compress(json.dumps({"ok": True}).encode("utf-8"))
        return httpx.Response(
            200,
            content=body,
            headers={"Content-Encoding": "gzip"},
            request=request,
        )

    _stub_wire(monkeypatch, responder)
    assert JsonHttpClient().get_json(URL) == {"ok": True}
