"""JsonHttpClient: retries, status mapping, deadlines — all offline."""

import time

import pytest

from src.errors import ResourceNotFoundError
from src.http_client import JsonHttpClient

URL = "https://nhentai.net/api/v2/search?query=language:english&page=1"


@pytest.fixture
def client():
    return JsonHttpClient()


def test_success_returns_parsed_json(client, fake_urlopen):
    fake_urlopen.push_json({"num_pages": 3, "result": []})
    assert client.get_json(URL) == {"num_pages": 3, "result": []}
    assert fake_urlopen.calls == [URL]


def test_404_raises_not_found_without_retry(client, fake_urlopen):
    fake_urlopen.push_http(404)
    with pytest.raises(ResourceNotFoundError):
        client.get_json(URL)
    assert len(fake_urlopen.calls) == 1


@pytest.mark.parametrize("status", [401, 403])
def test_auth_statuses_raise_without_retry(client, fake_urlopen, status):
    fake_urlopen.push_http(status)
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_urlopen.calls) == 1


def test_429_retried_and_retry_after_is_the_sleep_floor(client, fake_urlopen):
    fake_urlopen.push_http(429, {"Retry-After": "7"})
    fake_urlopen.push_json({"ok": True})
    assert client.get_json(URL) == {"ok": True}
    assert len(fake_urlopen.calls) == 2
    # Backoff alone would be 2s + up to 1s jitter; Retry-After wins.
    assert fake_urlopen.sleeps == [7.0]


def test_500_exhausts_exactly_three_attempts(client, fake_urlopen):
    for _ in range(3):
        fake_urlopen.push_http(500)
    with pytest.raises(RuntimeError):
        client.get_json(URL)
    assert len(fake_urlopen.calls) == 3
    assert len(fake_urlopen.sleeps) == 2  # no sleep after the last attempt


def test_url_error_is_retried(client, fake_urlopen):
    fake_urlopen.push_url_error()
    fake_urlopen.push_json({"ok": True})
    assert client.get_json(URL) == {"ok": True}
    assert len(fake_urlopen.calls) == 2


def test_deadline_already_passed_fails_before_any_request(client, fake_urlopen):
    with pytest.raises(RuntimeError):
        client.get_json(URL, deadline=time.monotonic() - 1)
    assert fake_urlopen.calls == []


def test_deadline_expiring_mid_backoff_raises_instead_of_sleeping(
    client, fake_urlopen
):
    fake_urlopen.push_http(429)  # backoff would be >= 2s
    fake_urlopen.push_json({"ok": True})
    with pytest.raises(RuntimeError):
        client.get_json(URL, deadline=time.monotonic() + 0.5)
    assert fake_urlopen.sleeps == []  # never slept past the deadline


def test_malformed_json_raises(client, fake_urlopen):
    fake_urlopen.push_raw(b"this is not json{")
    with pytest.raises(RuntimeError):
        client.get_json(URL)


def test_last_success_at_recorded_on_success_only(client, fake_urlopen):
    assert client.last_success_at is None
    fake_urlopen.push_http(404)
    with pytest.raises(ResourceNotFoundError):
        client.get_json(URL)
    assert client.last_success_at is None  # failures don't count

    fake_urlopen.push_json({"ok": True})
    before = time.time()
    client.get_json(URL)
    assert client.last_success_at is not None
    assert before <= client.last_success_at <= time.time()
