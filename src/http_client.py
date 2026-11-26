"""A small retrying JSON-over-HTTP client for the upstream API.

Owns the whole transport policy in one place: descriptive User-Agent,
per-attempt timeouts, exponential backoff with jitter, honoring the
upstream's Retry-After header, hard deadline support, and mapping HTTP
statuses to exceptions (404 -> ResourceNotFoundError, 401/403 ->
RuntimeError, 429/5xx and network errors -> retried, then RuntimeError).

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
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from src.errors import ResourceNotFoundError

logger = logging.getLogger(__name__)

USER_AGENT = (
    "SauceMeUpRNJesus/1.0 "
    "(https://github.com/leotanxd/sauce-me-up-rnjesus)"
)

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
    ):
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

    # -- Shared cooldown ----------------------------------------------
    # Set by whichever call observes a 429/403; checked once at the
    # start of each get_json. A call already inside its retry loop is
    # NOT interrupted — it is honouring Retry-After/backoff sleeps
    # itself, and in real time those sleeps run at least as long as
    # the cooldown its own 429 set. New calls are the storm risk, so
    # new calls are what fail fast.

    def _set_cooldown(self, seconds: float) -> None:
        with self._state_lock:
            self._cooldown_until = max(
                self._cooldown_until, self._clock() + seconds
            )

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
    def _retry_after_seconds(error: HTTPError) -> float | None:
        """The response's Retry-After as seconds, if it parses as one."""
        if error.headers is None:
            return None
        retry_after = error.headers.get("Retry-After")
        if not retry_after:
            return None
        try:
            return float(retry_after)
        except ValueError:
            return None

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

        def sleep_before_retry(attempt: int, error: HTTPError | None) -> None:
            delay = self._retry_delay(attempt)
            # Honour the upstream's Retry-After as a floor for the delay.
            if error is not None:
                retry_after = self._retry_after_seconds(error)
                if retry_after is not None:
                    delay = max(delay, retry_after)
            left = remaining()
            if left is not None and time.monotonic() + delay > deadline:
                raise RuntimeError("Upstream request deadline exceeded.")
            time.sleep(delay)

        for attempt in range(1, MAX_RETRIES + 1):
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
            request = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )

            try:
                with urlopen(request, timeout=timeout) as response:
                    # Non-200 statuses raise HTTPError via urlopen, so a
                    # response here is a success.
                    payload = json.loads(response.read().decode("utf-8"))
                    self.last_success_at = time.time()
                    return payload

            except HTTPError as error:
                status_code = error.code
                last_error = error

                if status_code == 404:
                    raise ResourceNotFoundError(
                        "The requested API resource could not be found."
                    ) from error

                if status_code == 401:
                    raise RuntimeError(
                        "The API rejected the request because authentication "
                        "is required for this endpoint."
                    ) from error

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
                    ) from error

                if status_code == 429:
                    # Signal-driven, never quota-assumed: cool down
                    # for the longest of the upstream's Retry-After,
                    # this attempt's own backoff, and the configured
                    # floor. Set on every 429 — retried or final — so
                    # the NEXT call fails fast whichever attempt the
                    # storm was observed on. This call's own retries
                    # are unaffected (the check is entry-only).
                    retry_after = self._retry_after_seconds(error)
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
                    error.close()
                    sleep_before_retry(attempt, error)
                    continue

                raise RuntimeError(
                    f"Could not retrieve data from the API: HTTP {status_code}"
                ) from error

            except (URLError, TimeoutError, ConnectionError) as error:
                last_error = error

                if attempt < MAX_RETRIES:
                    logger.warning("Network issue on attempt %s; retrying.", attempt)
                    sleep_before_retry(attempt, None)
                    continue

                raise RuntimeError(
                    f"Could not connect to the API: {error}"
                ) from error

            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise RuntimeError(
                    "The API returned data that could not be understood."
                ) from error

        raise RuntimeError(f"Could not retrieve data after retries: {last_error}")
