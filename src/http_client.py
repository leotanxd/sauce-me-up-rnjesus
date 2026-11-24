"""A small retrying JSON-over-HTTP client for the upstream API.

Owns the whole transport policy in one place: descriptive User-Agent,
per-attempt timeouts, exponential backoff with jitter, honoring the
upstream's Retry-After header, hard deadline support, and mapping HTTP
statuses to exceptions (404 -> ResourceNotFoundError, 401/403 ->
RuntimeError, 429/5xx and network errors -> retried, then RuntimeError).
"""

import json
import logging
import random
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from errors import ResourceNotFoundError

logger = logging.getLogger(__name__)

USER_AGENT = (
    "SauceMeUpRNJesus/1.0 "
    "(https://github.com/leotanxd/sauce-me-up-rnjesus)"
)

REQUEST_TIMEOUT_SECONDS = 10
MAX_RETRIES = 3
INITIAL_RETRY_DELAY_SECONDS = 2
MAX_JITTER_SECONDS = 1


class JsonHttpClient:
    """GETs JSON documents with retries, backoff, and deadlines."""

    def _retry_delay(self, attempt: int) -> float:
        """Calculate exponential backoff with random jitter."""
        base_delay = INITIAL_RETRY_DELAY_SECONDS * (2 ** (attempt - 1))
        jitter = random.uniform(0, MAX_JITTER_SECONDS)
        return base_delay + jitter

    def get_json(self, url: str, deadline: float | None = None) -> dict:
        """Request JSON data without authentication, with retries.

        ``deadline`` (a time.monotonic() timestamp) hard-caps the whole
        operation: each attempt's timeout shrinks to the remaining
        budget, and a backoff sleep that would overrun the deadline is
        skipped in favour of failing fast.
        """
        last_error = None

        def remaining() -> float | None:
            return None if deadline is None else deadline - time.monotonic()

        def sleep_before_retry(attempt: int, error: HTTPError | None) -> None:
            delay = self._retry_delay(attempt)
            # Honour the upstream's Retry-After as a floor for the delay.
            if error is not None and error.headers is not None:
                retry_after = error.headers.get("Retry-After")
                if retry_after:
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        pass
            left = remaining()
            if left is not None and time.monotonic() + delay > deadline:
                raise RuntimeError("Upstream request deadline exceeded.")
            time.sleep(delay)

        for attempt in range(1, MAX_RETRIES + 1):
            left = remaining()
            if left is not None and left <= 0:
                raise RuntimeError("Upstream request deadline exceeded.")
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
                    return json.loads(response.read().decode("utf-8"))

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
                    raise RuntimeError(
                        "The API refused the request. This endpoint may be "
                        "restricted or unavailable to this client."
                    ) from error

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
