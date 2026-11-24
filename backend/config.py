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
    recent_max: int = 300
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
    # /api/health freshness window: an upstream success within this
    # many seconds reports "ok"; older is "stale"; none yet is
    # "unknown". 15 min matches the free service's idle spin-down, so
    # a live process that has served traffic recently reads "ok".
    health_fresh_seconds: float = 900.0
    # Local dev origins for the Vite dev server.
    cors_origins: tuple = ("http://localhost:5173", "http://127.0.0.1:5173")
    # Client-facing failure text. Internal exception details go to the
    # server log, never into API responses.
    upstream_502_text: str = "Upstream request failed. Please retry."
