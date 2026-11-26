"""In-process metrics registry (Package 4): plain counters + locks.

Deliberately boring: a fixed, low-cardinality set of counters and
one batch-duration summary, kept in dicts behind a lock and served
as JSON by /api/metrics. No per-gallery labels (cardinality AND
privacy), no new dependency, no external service — the numbers live
and die with the process, which matches the single-instance
deployment (see DEPLOY.md's scale-out note). Their job is tuning:
the Package 2 cooldown/budget defaults and the Package 3 cache/pool
sizing were chosen generously on purpose, and these counters are
how later changes earn tighter values.

Consumers receive the registry by injection and may pass None
(metrics disabled / direct construction), in which case every
instrumentation site simply skips counting.
"""

import threading
import time

# Upstream endpoint classes: the only upstream URLs are search,
# gallery detail, and the CDN config; anything else is "other".
ENDPOINT_CLASSES = ("search", "detail", "cdn", "other")
# Per-attempt outcomes: HTTP status classes, plus transport failures
# (no response at all) as their own class.
STATUS_CLASSES = ("2xx", "3xx", "4xx", "5xx", "network_error")
# Feed modes, for pool refill counts.
POOL_MODES = ("random", "popular")

# Batch-duration bucket bounds (seconds). A batch's wall time lands
# in exactly one bucket: the first bound it fits, else "over".
BATCH_DURATION_BOUNDS = (1.0, 5.0, 10.0, 20.0, 45.0)


def _bucket_keys() -> list[str]:
    keys = [f"le_{int(bound)}s" for bound in BATCH_DURATION_BOUNDS]
    keys.append("over")
    return keys


def _initial_counters() -> dict[str, int]:
    """The full fixed counter set, zeroed — the snapshot's shape is
    stable from boot, so consumers never guess which keys exist."""
    counters: dict[str, int] = {}
    for endpoint in ENDPOINT_CLASSES:
        for status in STATUS_CLASSES:
            counters[f"upstream.calls.{endpoint}.{status}"] = 0
    counters["upstream.retries"] = 0
    counters["upstream.rate_limited"] = 0  # 429 responses observed
    counters["upstream.cooldown_activations"] = 0
    counters["upstream.budget_exhausted"] = 0
    counters["detail_cache.hits"] = 0
    counters["detail_cache.misses"] = 0
    for mode in POOL_MODES:
        counters[f"pool.refills.{mode}"] = 0
        counters[f"pool.background_refills.{mode}"] = 0
    # Pick outcomes, counted once per event in SaucePicker.next:
    # a verified serve, each rejected candidate (re-roll), the
    # unverified last-resort serve, and each pick that 502s.
    counters["picks.served"] = 0
    counters["picks.rerolled"] = 0
    counters["picks.fallback"] = 0
    counters["picks.error"] = 0
    return counters


class Metrics:
    """Thread-safe counters + batch-duration summary."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._started_at = clock()
        self._lock = threading.Lock()
        self._counters = _initial_counters()
        self._batch_count = 0
        self._batch_sum = 0.0
        self._batch_max = 0.0
        self._batch_buckets = {key: 0 for key in _bucket_keys()}

    def _incr(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + amount

    # -- Upstream (JsonHttpClient) ------------------------------------

    def upstream_call(self, endpoint_class: str, status_class: str) -> None:
        """One upstream attempt and how it ended."""
        self._incr(f"upstream.calls.{endpoint_class}.{status_class}")

    def upstream_retry(self) -> None:
        """An attempt beyond the first within one get_json call."""
        self._incr("upstream.retries")

    def upstream_rate_limited(self) -> None:
        """A 429 response was observed."""
        self._incr("upstream.rate_limited")

    def cooldown_activated(self) -> None:
        """The shared cooldown window was set or extended."""
        self._incr("upstream.cooldown_activations")

    def budget_exhausted(self) -> None:
        """A call failed fast because the request budget ran out."""
        self._incr("upstream.budget_exhausted")

    # -- Detail cache (SaucePicker lookups) ----------------------------

    def detail_cache_hit(self) -> None:
        self._incr("detail_cache.hits")

    def detail_cache_miss(self) -> None:
        self._incr("detail_cache.misses")

    # -- Search pools ---------------------------------------------------

    def pool_refill(self, mode: str) -> None:
        """One search page fetched into a mode's pool (any path)."""
        self._incr(f"pool.refills.{mode}")

    def pool_background_refill(self, mode: str) -> None:
        """A refill that ran on the background low-water thread."""
        self._incr(f"pool.background_refills.{mode}")

    # -- Picks ----------------------------------------------------------

    def pick_served(self) -> None:
        self._incr("picks.served")

    def pick_rerolled(self) -> None:
        self._incr("picks.rerolled")

    def pick_fallback(self) -> None:
        self._incr("picks.fallback")

    def pick_error(self) -> None:
        self._incr("picks.error")

    # -- Batch duration -------------------------------------------------

    def observe_batch_duration(self, seconds: float) -> None:
        with self._lock:
            self._batch_count += 1
            self._batch_sum += seconds
            self._batch_max = max(self._batch_max, seconds)
            for bound, key in zip(
                BATCH_DURATION_BOUNDS, _bucket_keys(), strict=False
            ):
                if seconds <= bound:
                    self._batch_buckets[key] += 1
                    break
            else:
                self._batch_buckets["over"] += 1

    # -- Snapshot ---------------------------------------------------------

    def snapshot(self) -> dict:
        """The /api/metrics body: counters + batch-duration summary."""
        with self._lock:
            return {
                "uptimeSeconds": round(self._clock() - self._started_at, 3),
                "counters": dict(self._counters),
                "batchDurationSeconds": {
                    "count": self._batch_count,
                    "sum": round(self._batch_sum, 6),
                    "max": round(self._batch_max, 6),
                    "buckets": dict(self._batch_buckets),
                },
            }
