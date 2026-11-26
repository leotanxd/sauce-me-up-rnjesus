"""A small retrying JSON-over-HTTP client for the upstream API.

Owns the whole transport policy in one place: descriptive User-Agent,
per-attempt timeouts, exponential backoff with jitter, honoring the
upstream's Retry-After header, hard deadline support, and mapping HTTP
statuses to exceptions (404 -> ResourceNotFoundError, 401/403 ->
RuntimeError, 429/5xx and network errors -> retried, then RuntimeError).

The wire itself is a pooled httpx client (Package 3): connections are
kept alive and reused across calls instead of paying a fresh TCP+TLS
handshake per request, and responses are gzip-decoded by httpx. The
transport sits behind a one-method seam (``get(url, headers, timeout)``
-> a response with ``status_code`` / ``headers`` / ``content``, raising
``httpx.TransportError`` on network failure) so tests can script it.

Two process-wide protections live here too, because every upstream
call (search, detail, CDN config) funnels through get_json:

- A shared cooldown: a 429 (or 403) response puts the whole process
  into a cooldown window during which new calls fail fast instead of
  each retrying independently into the storm. The window is driven by
  observed signals only (the response's Retry-After and the client's
  own backoff), never by an assumed quota figure.
- A global token-bucket budget: upstream *requests* (one token per
  attempt) are bounded in rate no matter how many visitors arrive;
  exhaustion fails fast and surfaces upstream as the usual errors.
"""

import json
import logging
import random
import threading
import time
from collections.abc import Mapping

import httpx

from src.errors import ResourceNotFoundError
from src.request_context import RequestIdLogFilter

logger = logging.getLogger(__name__)
logger.addFilter(RequestIdLogFilter())

USER_AGENT = "SauceMeUpRNJesus/1.0 (https://github.com/leotanxd/sauce-me-up-rnjesus)"

REQUEST_TIMEOUT_SECONDS = 10
MAX_RETRIES = 3
INITIAL_RETRY_DELAY_SECONDS = 2
MAX_JITTER_SECONDS = 1

# Defaults mirror backend.config.Settings (the composition root
# passes the Settings values in explicitly; these keep direct
# construction — CLI, tests — on the same conservative values). The
# budget numbers are deliberately generous starting values, sized
# without any assumed upstream quota; they exist to bound request
# storms, and Package 4's metrics are the tool for tightening them.
DEFAULT_COOLDOWN_SECONDS = 5.0
DEFAULT_FORBIDDEN_COOLDOWN_SECONDS = 300.0
DEFAULT_BUDGET_RATE_PER_MINUTE = 120.0
DEFAULT_BUDGET_BURST = 40


class _PooledTransport:
    """The default transport: one pooled httpx.Client, shared by every
    thread using this JsonHttpClient (httpx clients are thread-safe).

    Keep-alive connections are reused across upstream calls, and
    httpx sends Accept-Encoding and decodes gzip responses itself.
    ``trust_env=False`` keeps the client talking directly to the
    upstream — no proxy or other environment configuration leaks into
    upstream traffic. Redirects are followed, as urllib did.
    """

    def __init__(self):
        self._client = httpx.Client(
            trust_env=False,
            follow_redirects=True,
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=10,
            ),
        )

    def get(self, url: str, headers: dict, timeout: float):
        return self._client.get(url, headers=headers, timeout=timeout)


def _create_default_transport() -> _PooledTransport:
    """Factory for the default transport (the tests' patch point)."""
    return _PooledTransport()


class JsonHttpClient:
    """GETs JSON documents with retries, backoff, and deadlines."""

    def __init__(
        self,
        *,
        cooldown_default_seconds: float = DEFAULT_COOLDOWN_SECONDS,
        forbidden_cooldown_seconds: float = DEFAULT_FORBIDDEN_COOLDOWN_SECONDS,
        budget_rate_per_minute: float | None = DEFAULT_BUDGET_RATE_PER_MINUTE,
        budget_burst: int = DEFAULT_BUDGET_BURST,
        clock=time.monotonic,
        transport=None,
        metrics=None,
    ):
        # Package 4 metrics registry (src.metrics.Metrics) or None:
        # every attempt, retry, 429, cooldown activation, and budget
        # exhaustion is counted when one is wired in.
        self._metrics = metrics
        # The wire seam: anything with get(url, headers, timeout)
        # returning a response with .status_code/.headers/.content
        # and raising httpx.TransportError on network failure. The
        # default transport is created lazily on first use, so
        # constructing a client never opens a connection pool (and
        # tests can patch the factory after construction).
        self._transport = transport
        self._default_transport = None
        self._transport_lock = threading.Lock()
        # Wall-clock time of the last successful upstream response,
        # or None if none has succeeded yet. Every upstream call goes
        # through get_json, so this is the process's observed upstream
        # contact — read by the /api/health endpoint (never probed).
        self.last_success_at: float | None = None
        # Cooldown + budget state. The clock is injectable (tests);
        # it must be monotonic — deadlines stay on time.monotonic
        # directly because callers pass monotonic timestamps in.
        self._clock = clock
        self._cooldown_default_seconds = cooldown_default_seconds
        self._forbidden_cooldown_seconds = forbidden_cooldown_seconds
        self._budget_rate_per_minute = budget_rate_per_minute
        self._budget_burst = budget_burst
        self._state_lock = threading.Lock()
        self._cooldown_until = 0.0  # on self._clock; 0 = not cooling
        self._budget_tokens = float(budget_burst)
        self._budget_updated_at = clock()

    def _get_transport(self):
        """The transport to send through, creating the default once."""
        if self._transport is not None:
            return self._transport
        with self._transport_lock:
            if self._default_transport is None:
                self._default_transport = _create_default_transport()
            return self._default_transport

    # -- Shared cooldown ----------------------------------------------
    # Set by whichever call observes a 429/403; checked once at the
    # start of each get_json. A call already inside its retry loop is
    # NOT interrupted — it is honouring Retry-After/backoff sleeps
    # itself, and in real time those sleeps run at least as long as
    # the cooldown its own 429 set. New calls are the storm risk, so
    # new calls are what fail fast.

    def _set_cooldown(self, seconds: float) -> None:
        with self._state_lock:
            new_until = self._clock() + seconds
            activated = new_until > self._cooldown_until
            self._cooldown_until = max(self._cooldown_until, new_until)
        if activated and self._metrics is not None:
            # Only a window that actually moves counts as an
            # activation; a 429 landing inside an already-longer
            # window adds nothing new to know.
            self._metrics.cooldown_activated()

    def _check_cooldown(self) -> None:
        with self._state_lock:
            until = self._cooldown_until
        if self._clock() < until:
            raise RuntimeError(
                "Upstream asked this client to slow down (rate-limit "
                "cooldown in effect); failing fast instead of retrying."
            )

    def cooldown_until(self) -> float | None:
        """Wall-clock time the current cooldown ends, or None.

        Read by /api/health as an informational field; converts the
        internal monotonic deadline to wall time via the remaining
        span, so it stays correct under clock adjustments.
        """
        with self._state_lock:
            remaining = self._cooldown_until - self._clock()
        if remaining <= 0:
            return None
        return time.time() + remaining

    # -- Global request budget -----------------------------------------
    # One token per upstream *attempt* (retries spend real requests,
    # so they spend tokens). Refills continuously at the configured
    # rate up to the burst cap. Exhaustion raises immediately — the
    # pick layer maps that to its existing 502/retry behaviour.

    def _consume_budget_token(self) -> None:
        rate = self._budget_rate_per_minute
        if rate is None or rate <= 0:
            return  # budget disabled
        with self._state_lock:
            now = self._clock()
            elapsed = now - self._budget_updated_at
            self._budget_updated_at = now
            self._budget_tokens = min(
                float(self._budget_burst),
                self._budget_tokens + elapsed * rate / 60.0,
            )
            if self._budget_tokens < 1.0:
                if self._metrics is not None:
                    self._metrics.budget_exhausted()
                raise RuntimeError(
                    "Upstream request budget exhausted; failing fast "
                    "to bound total upstream pressure."
                )
            self._budget_tokens -= 1.0

    def _retry_delay(self, attempt: int) -> float:
        """Calculate exponential backoff with random jitter."""
        base_delay = INITIAL_RETRY_DELAY_SECONDS * (2 ** (attempt - 1))
        jitter = random.uniform(0, MAX_JITTER_SECONDS)
        return base_delay + jitter

    @staticmethod
    def _retry_after_seconds(headers: Mapping | None) -> float | None:
        """The response's Retry-After as seconds, if it parses as one."""
        if headers is None:
            return None
        retry_after = headers.get("Retry-After")
        if not retry_after:
            return None
        try:
            return float(retry_after)
        except ValueError:
            return None

    @staticmethod
    def _endpoint_class(url: str) -> str:
        """The metrics label for a URL: search / detail / cdn / other.

        Path classes only — never the gallery ID or query string,
        so the counters stay low-cardinality.
        """
        if "/api/v2/search" in url:
            return "search"
        if "/api/v2/galleries/" in url:
            return "detail"
        if "/api/v2/cdn" in url:
            return "cdn"
        return "other"

    def get_json(self, url: str, deadline: float | None = None) -> dict:
        """Request JSON data without authentication, with retries.

        ``deadline`` (a time.monotonic() timestamp) hard-caps the whole
        operation: each attempt's timeout shrinks to the remaining
        budget, and a backoff sleep that would overrun the deadline is
        skipped in favour of failing fast.
        """
        last_error = None

        # A cooldown set by any recent call (429/403 storm) fails
        # this call fast, before any request is spent on it.
        self._check_cooldown()

        def remaining() -> float | None:
            return None if deadline is None else deadline - time.monotonic()

        def sleep_before_retry(attempt: int, headers: Mapping | None) -> None:
            delay = self._retry_delay(attempt)
            # Honour the upstream's Retry-After as a floor for the delay.
            if headers is not None:
                retry_after = self._retry_after_seconds(headers)
                if retry_after is not None:
                    delay = max(delay, retry_after)
            left = remaining()
            if left is not None and delay > left:
                raise RuntimeError("Upstream request deadline exceeded.")
            time.sleep(delay)

        endpoint_class = self._endpoint_class(url)

        for attempt in range(1, MAX_RETRIES + 1):
            if attempt > 1 and self._metrics is not None:
                self._metrics.upstream_retry()
            left = remaining()
            if left is not None and left <= 0:
                raise RuntimeError("Upstream request deadline exceeded.")
            # Every attempt spends a real upstream request, so every
            # attempt spends a budget token; exhaustion fails fast.
            self._consume_budget_token()
            timeout = (
                REQUEST_TIMEOUT_SECONDS
                if left is None
                else min(REQUEST_TIMEOUT_SECONDS, left)
            )
            headers = {
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                # Explicit, though httpx would send and decode gzip
                # on its own: compression is part of the contract.
                "Accept-Encoding": "gzip",
            }

            try:
                response = self._get_transport().get(url, headers, timeout)
            except httpx.TransportError as error:
                # Connection failures and timeouts (TimeoutException
                # is a TransportError) are transient: retried, then a
                # RuntimeError, exactly as the urllib path behaved.
                if self._metrics is not None:
                    self._metrics.upstream_call(endpoint_class, "network_error")
                last_error = error

                if attempt < MAX_RETRIES:
                    logger.warning("Network issue on attempt %s; retrying.", attempt)
                    sleep_before_retry(attempt, None)
                    continue

                raise RuntimeError(f"Could not connect to the API: {error}") from error

            status_code = response.status_code

            if self._metrics is not None:
                self._metrics.upstream_call(endpoint_class, f"{status_code // 100}xx")
                if status_code == 429:
                    self._metrics.upstream_rate_limited()

            if status_code == 200:
                try:
                    payload = json.loads(response.content.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as error:
                    raise RuntimeError(
                        "The API returned data that could not be understood."
                    ) from error
                self.last_success_at = time.time()
                return payload

            if status_code == 404:
                raise ResourceNotFoundError(
                    "The requested API resource could not be found."
                )

            if status_code == 401:
                raise RuntimeError(
                    "The API rejected the request because authentication "
                    "is required for this endpoint."
                )

            if status_code == 403:
                # A refusal is not transient per-request noise:
                # put the whole process into the long cooldown so
                # subsequent calls fail fast instead of hammering
                # a door that just closed.
                self._set_cooldown(self._forbidden_cooldown_seconds)
                logger.warning(
                    "Upstream returned 403; entering a %ss cooldown "
                    "during which new upstream calls fail fast.",
                    self._forbidden_cooldown_seconds,
                )
                raise RuntimeError(
                    "The API refused the request. This endpoint may be "
                    "restricted or unavailable to this client."
                )

            if status_code == 429:
                # Signal-driven, never quota-assumed: cool down
                # for the longest of the upstream's Retry-After,
                # this attempt's own backoff, and the configured
                # floor. Set on every 429 — retried or final — so
                # the NEXT call fails fast whichever attempt the
                # storm was observed on. This call's own retries
                # are unaffected (the check is entry-only).
                retry_after = self._retry_after_seconds(response.headers)
                self._set_cooldown(
                    max(
                        retry_after or 0.0,
                        self._retry_delay(attempt),
                        self._cooldown_default_seconds,
                    )
                )

            if (status_code == 429 or 500 <= status_code < 600) and (
                attempt < MAX_RETRIES
            ):
                logger.warning(
                    "Upstream HTTP %s on attempt %s; retrying.",
                    status_code,
                    attempt,
                )
                sleep_before_retry(attempt, response.headers)
                continue

            raise RuntimeError(
                f"Could not retrieve data from the API: HTTP {status_code}"
            )

        raise RuntimeError(f"Could not retrieve data after retries: {last_error}")
