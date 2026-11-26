"""Backend configuration: the one home for the API's tunables.

Defaults preserve the values the code has always run with. Budgets
are wall-clock caps so a request can never hang for minutes through
the retry/re-roll chain: one pick gets ~20s, a whole batch ~45s.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    # No-repeat memory window: IDs served recently are skipped, so a
    # batch never contains duplicates and a refresh shows new sauces.
    # Widened 300 -> 1000 as cheap insurance: the window is shared by
    # every visitor and churned by kept re-roll reservations, so a
    # bigger window lengthens the post-refresh grace while this
    # process lives. It is still in-process only — a restart wipes
    # it; the durable cross-refresh memory is the client's persisted
    # seen list (frontend/src/lib/seenSauce.ts).
    recent_max: int = 1000
    # Wall-clock budgets (seconds).
    pick_budget_seconds: float = 20.0
    batch_budget_seconds: float = 45.0
    # Concurrent picks per batch. Details are the hot upstream path
    # (~20/min/IP anonymous): at most this many detail calls are in
    # flight per batch, so a 10-batch drains in ~3 waves — inside
    # both the rate limit and the batch budget.
    batch_concurrency: int = 4
    # Short-lived gallery-detail cache: /next fetches a detail, and
    # /pages for the same gallery usually follows seconds later.
    detail_ttl_seconds: float = 300.0
    detail_cache_max: int = 128
    # Shared upstream cooldown (Package 2): after a 429, new upstream
    # calls fail fast for at least this long — the actual window is
    # the longest of this floor, the response's Retry-After, and the
    # client's own backoff, all observed signals (no quota figure is
    # assumed anywhere). A 403 earns the much longer forbidden
    # cooldown: a refusal is a closed door, not a passing storm.
    upstream_cooldown_default_seconds: float = 5.0
    upstream_forbidden_cooldown_seconds: float = 300.0
    # Global upstream request budget (Package 2): a token bucket in
    # the HTTP client bounds total upstream requests (one token per
    # attempt) no matter how many visitors arrive. Deliberately
    # generous starting values — they bound storms, not normal use;
    # tighten with Package 4's metrics, not with folklore.
    global_budget_rate_per_minute: float = 120.0
    global_budget_burst: int = 40
    # Search-pool low-water mark (Package 3): when a draw leaves a
    # mode's pool below this many galleries, a background thread
    # refills it, so draws rarely wait on a synchronous refill. 0
    # disables background refills.
    pool_low_water_mark: int = 5
    # CDN config refresh (Package 3): the /api/v2/cdn server lists
    # are refetched after this long instead of being cached forever;
    # a failed refresh serves the stale config.
    cdn_config_ttl_seconds: float = 3600.0
    # /api/health freshness window: an upstream success within this
    # many seconds reports "ok"; older is "stale"; none yet is
    # "unknown". 15 min matches the free service's idle spin-down, so
    # a live process that has served traffic recently reads "ok".
    health_fresh_seconds: float = 900.0
    # Metrics (Package 4): the in-process registry + /api/metrics.
    # The counters are the tuning evidence for the Package 2/3
    # defaults above; disabling drops the endpoint and the counting.
    metrics_enabled: bool = True
    # Startup warm-up (Package 4): after boot, a daemon thread primes
    # the search pools and the CDN config under this one deadline, so
    # the first visitor after a spin-down doesn't pay those fetches
    # serially. Best-effort — a failed warm-up never blocks boot.
    warm_up_deadline_seconds: float = 10.0
    # Local dev origins for the Vite dev server.
    cors_origins: tuple = ("http://localhost:5173", "http://127.0.0.1:5173")
    # Client-facing failure text. Internal exception details go to the
    # server log, never into API responses.
    upstream_502_text: str = "Upstream request failed. Please retry."
