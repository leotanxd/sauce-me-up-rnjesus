/** Frontend tunables — the one home for values that mirror backend settings. */

/** Sauces per fetch. The backend's /api/sauce/batch default
 * (backend/routers/sauce.py, Query(default=3)) mirrors this value —
 * the two are the same setting in two languages; keep them in step. */
export const BATCH_SIZE = 3

/** Per-fetch abort timeout (ms). The relationship to the backend
 * budgets (backend/config.py Settings) is asymmetric, and both halves
 * are deliberate:
 *  - It EXCEEDS the single-pick budget (pick_budget_seconds = 20s,
 *    which caps /api/sauce/next and /api/sauce/{id}/pages), so a normal
 *    pick always resolves — or returns its own 502 — before the client
 *    would give up on it.
 *  - It is SHORTER than the batch budget (batch_budget_seconds = 45s,
 *    the server-side worst case for /api/sauce/batch). A batch that has
 *    not answered in 30s is abandoned client-side and the feed shows
 *    its error/retry state, rather than leaving the user waiting for
 *    the server's full worst case. In practice pooled picks answer in
 *    a few seconds; the 45s only bounds a pathological upstream. */
export const FETCH_TIMEOUT_MS = 30_000
