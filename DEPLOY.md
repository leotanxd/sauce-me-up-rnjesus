# Deploying — free, one public URL

The app deploys as **one service**: the Docker image builds the React
frontend, and FastAPI serves both `/api/*` and the built frontend.
No database, no secrets, no environment variables.

## Option A — Render (recommended, free)

1. Sign up at https://render.com (no credit card for the free plan).
2. **New → Web Service** (or **New → Blueprint** and pick this repo —
   `render.yaml` is already in the root).
3. Connect the GitHub repo `leotanxd/sauce-me-up-rnjesus`.
4. Runtime: **Docker**, Plan: **Free**. Everything else can stay default —
   Render uses the `Dockerfile` in the repo root and the `$PORT` it assigns.
5. **Create Web Service.** First build takes a few minutes.
6. Your public link is shown on the service page, in the form
   `https://sauce-me-up-rnjesus.onrender.com` — anyone can open it.

Notes:
- Free services **spin down after ~15 minutes idle**; the next visitor
  waits ~30-60 s for it to wake. That's normal on the free plan.
- Every push to `main` triggers a new deploy automatically.
- A custom domain can be added later under the service's Settings.
- Render's health check points at `/api/health` (`healthCheckPath` in
  `render.yaml`). The endpoint only reports observed state — it never
  probes upstream — so checks cost no upstream quota.
- `GET /api/metrics` serves the process's in-process counters
  (upstream calls/retries/429s, cooldown activations, detail-cache
  hits/misses, pool refills, pick outcomes, batch durations). They
  reset on every restart; there is no external metrics service.
- The upstream client talks to the upstream **directly**: it ignores
  proxy environment variables (`HTTP_PROXY` etc.) by design
  (`trust_env=False` on the pooled httpx client), so no proxy
  configuration on the host can leak into or reroute upstream traffic.
- The no-repeat memory, search-result pool, and caches are **per
  process**: keep the service at one uvicorn worker / one instance, or
  the "no repeats" window fragments across processes. See
  "Scaling out" below before changing that.

## Scaling out — read before adding workers or instances

Everything stateful in this app lives **in the one process's memory**.
That is a deliberate design choice for a single free instance, and it
means `--workers > 1` or a second instance is NOT safe today: each
process would keep its own divergent copy of every item below. Before
scaling out, each one needs a shared home (e.g. Redis) or an explicit
decision that divergence is acceptable:

| Per-process state | Where it lives | What breaks if it diverges |
| --- | --- | --- |
| No-repeat window (last ~1000 served IDs) | `RecentServedStore` (`backend/stores.py`) | The same gallery can be served by two processes back-to-back; batches stay internally duplicate-free only |
| Gallery detail cache (TTL + LRU) | `DetailCache` (`backend/stores.py`) | Just extra upstream detail fetches — wasteful, not incorrect |
| Search-result pools, per feed mode | `SearchPool` (`src/pools.py`) | Extra search fetches; modes stay correct per process |
| Upstream 429/403 cooldown + request budget | `JsonHttpClient` (`src/http_client.py`) | Each process keeps its own cooldown and spends its own full budget — total upstream pressure multiplies by the process count, defeating both protections |
| Detail single-flight map | `SaucePicker` (`backend/picker.py`) | Duplicate in-flight detail fetches across processes (the Package 2 waste returns) |
| Metrics registry | `Metrics` (`src/metrics.py`) | `/api/metrics` reports only the answering process's counters |
| CDN config cache | `MediaUrlBuilder` (`src/cdn.py`) | Harmless: one extra config fetch per process per TTL window |

Until that shared-state work is done (it is deliberately not built —
see the implementation plan's Package 4 notes), run exactly one
uvicorn worker in exactly one instance, which is what the Dockerfile
and `render.yaml` do.

## Base-image digests

The Dockerfile pins both base images by digest
(`node:24-slim@sha256:…`, `python:3.12-slim@sha256:…`) so a rebuild
cannot silently pick up a different image under the same tag.
Refresh them manually — monthly-ish, or when Node/Python publish
security releases:

```bash
# Prints the current manifest-list digest for a tag:
curl -s "https://hub.docker.com/v2/repositories/library/node/tags/24-slim" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['digest'])"
curl -s "https://hub.docker.com/v2/repositories/library/python/tags/3.12-slim" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['digest'])"
```

Paste the new digest into the `FROM` line, rebuild, and run the test
suites before pushing — a digest bump is a dependency change like
any other. Python dependencies are likewise frozen with hashes in
`requirements.txt` / `requirements-dev.txt` (regenerate with
`pip-compile --generate-hashes` from `pyproject.toml`; never
hand-edit them).

## Option B — the same Docker image anywhere else

```bash
docker build -t sauce-me-up .
docker run -p 8000:8000 -e PORT=8000 sauce-me-up
# http://localhost:8000
```

Works on any Docker host (a VPS, Fly.io, Koyeb, Google Cloud Run, …).

## First live check

Open the URL, then `https://<your-url>/api/health` should return
HTTP 200 with a body like
`{"status":"ok","upstream":{"lastSuccessAt":"2026-01-01T00:00:00Z","upstreamStatus":"ok"}}`.
The `upstream` block reports the last observed contact with the
upstream catalogue: `upstreamStatus` is `"ok"` if a call succeeded
within the last 15 minutes, `"stale"` if it has been longer, and
`"unknown"` (with `"lastSuccessAt": null`) if this process hasn't
reached upstream yet. The endpoint never probes upstream itself, so
`status` stays `"ok"` as long as the app is up. If the feed shows an
error with a retry button, the backend's upstream calls are failing
from that host — check the service logs first. (Demo placeholders
exist only in development builds.)
