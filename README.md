# Sauce Me Up, RNJesus

A TikTok-style vertical feed of random English-language sauces — or
the currently popular ones, if you'd rather. Every visit serves up
different galleries, one full-screen card at a time — no account, no
setup, just scroll.

> As of 2026, November 25th, this project is currently being released as a public beta prototype, and if for some reason people actually start using this, then I will update the website. Otherwise, I only made this project just for the fun of it, and I might not update it, unless I feel like updating it.

## ▶ Try it live

**[https://sauce-me-up-rnjesus.onrender.com](https://sauce-me-up-rnjesus.onrender.com)**

Click the link and the feed loads right in your browser. (It's on a
free host, so the very first load after a quiet period can take up to
a minute while the service wakes up — the waiting animation means
it's working.)

## Features

- **Random | Popular modes** — draw from the whole catalogue, or from
  what's popular this week.
- **No repeats** — the last 1000 sauces served are remembered
  server-side, and your browser remembers the last 500 per mode
  across visits, so scrolling never loops back on itself — not
  even after a refresh.
- **Batches of 3, generated concurrently** — the feed tops itself up
  as you approach the end, so there's always another card.
- **Blur on by default** — every image starts blurred; tap the image
  to show it.
- **Image-only zoom** — pinch, double-tap, `Ctrl`+scroll or the
  `+`/`−` keys zoom the picture alone; every button and caption
  stays its normal size. `Ctrl`+`Shift`+scroll does the reverse —
  it scales the UI only — and that level is remembered between
  visits.
- **In-gallery paging three ways** — the ‹ › buttons, the ← → arrow
  keys, or a horizontal swipe on the image.
- **Page X of Y, always shown** — every card displays its page
  indicator in the right-side column, from the moment it loads.
- **Condensed titles** — long titles shrink to a few words at any
  screen size; tap to expand the full title in a narrow panel, tap
  again to collapse.
- **Dim mode** — one toggle hides the right-side column and every
  other button and caption, leaving just the image (and the Dim
  toggle itself, so you can get back).
- **Thumb-sized controls** — the feed's main buttons (paging ‹ ›,
  ↗ Source, Random | Popular, Dim, and Retry) are at
  least 48px in both dimensions, sized for thumbs on mobile and
  easy clicking on desktop.
- **Feed windowing** — only the cards near the one you're viewing
  are mounted, so long sessions stay light and smooth.
- A loading animation while the next batch generates.

## How to use it

| Action | What it does |
| --- | --- |
| Scroll / swipe up-down, or `↑` / `↓` arrow keys | Move to the next / previous sauce |
| Swipe left / right on the image | Next / previous page of the sauce you're viewing |
| `→` arrow key (or the `›` button) | Next page of the sauce you're viewing |
| `←` arrow key (or the `‹` button) | Previous page of that sauce |
| Tap the image | Toggle the blur |
| Pinch on the image, or `Ctrl`+scroll / trackpad pinch | Zoom the image only — buttons and text keep their size |
| Double-tap the image | Toggle 2.5× image zoom, centred where you tapped |
| Drag while zoomed | Pan around the zoomed image |
| `+` / `−` keys | Zoom the image in / out; `0` or `Esc` resets the image zoom |
| `Ctrl`+`Shift`+scroll | Zoom the buttons and text only (the UI), not the image |
| `Ctrl`+`Shift`+`0` | Reset the UI zoom |
| **Dim: ON/OFF** toggle (right side) | Hide / show all buttons and text |
| Tap the title | Expand a condensed title; tap again to collapse |
| **↗ Source** button | Open the gallery at the source site |

Things to know:

- Each card shows the sauce's ID (`#…`), its title, and a
  **Page X of Y** indicator together in the right-side column,
  above the Dim toggle.
- The first page is what loads with the feed; the rest of a
  gallery's pages are fetched lazily, only when you start paging
  through it — by button, arrow key, or first swipe.
- While dimmed, everything hides except the image and the Dim
  toggle itself (at reduced opacity). Tapping the image still
  toggles blur; it doesn't exit dim mode.
- While sauces are generating (first load, or when you reach the
  end of the feed), a waiting animation plays in the center of the
  page.
- Nothing persists across reloads — blur and dim reset, and
  refreshing starts a fresh feed with different sauces. The one
  exception is the UI zoom level (`Ctrl`+`Shift`+scroll), which is
  remembered between visits.

## Architecture

Three parts: a Python core package, a FastAPI backend, and a React
frontend. The backend serves the API and the built frontend as one
service.

- **`src/`** — an installable Python package (see `pyproject.toml`)
  that talks to the upstream catalogue (the nhentai API v2):
  - `http_client` — JSON transport with retry/backoff and
    deadline-aware timeouts.
  - `pools` — per-mode search pools (`FeedMode`: random / popular),
    so picks draw from buffered result pages instead of one request
    per sauce.
  - `models` — frozen dataclasses parsed once at the boundary;
    title priority, page ordering, and the English-language check
    live here.
  - `cdn` — builds media URLs across the upstream's CDN mirrors.
  - `client` — the `NhentaiClient` facade the backend uses.
  - `cli` — a small command-line front end (`python -m src.cli`).
- **`backend/`** — FastAPI, composed in `create_app()`:
  - `picker` — the serving service. Picks use **reserve-at-draw**
    concurrency: an ID is atomically checked-and-reserved under a
    lock, all network work happens outside the lock, and batches
    generate in parallel (concurrency cap 4) without ever serving a
    duplicate.
  - `stores` — the no-repeat window (last 1000 served) and the
    detail cache (300s TTL, max 128 entries).
  - Pydantic response schemas, so the wire format is explicit.
  - **Cache-header policy** — `/assets/*` is served immutable (the
    filenames are hashed), HTML is `no-cache` (deploys show up
    immediately), and `/api/*` is left unstamped.
  - **Truthful `/api/health`** — always HTTP 200 with
    `status: "ok"`, plus an `upstream` block reporting `ok` /
    `stale` / `unknown` from the last observed upstream success
    (15-minute freshness window). It never probes upstream, so
    health checks cost no quota.
  - **`/api/metrics` + request IDs** — in-process, low-cardinality
    counters (upstream calls/retries/429s, cooldown activations,
    detail-cache hits/misses, pool refills, pick outcomes, batch
    durations) served as JSON; every request carries an
    `X-Request-ID` that also prefixes its server log lines, so a
    client-visible failure can be matched to the logs.
- **`frontend/`** — Vite + React + Tailwind. All state lives in
  hooks — `useSauceFeed` (feed, modes, blur, dim), `useGalleryPages`
  (per-card paging), `useHorizontalSwipe` (swipe paging),
  `useImageZoom` (per-card image-only zoom) and `useUiZoom`
  (feed-level UI zoom) — and the components are layout only. The feed windows rendering to the
  active card ±2.

Project layout:

```
src/          Python core package (upstream client)
backend/      FastAPI app (api, picker, stores, routers)
frontend/     React feed UI (hooks own the state)
tests/        Backend pytest suite (fully offline)
Dockerfile    Single-service image (see DEPLOY.md)
```

## Development

Prerequisites: Python ≥ 3.11 and Node 24.

```bash
pip install -e ".[test]"   # the package (incl. httpx) plus test deps (pytest)
                           # runtime only: pip install -e .
                           # reproducible installs: requirements.txt /
                           # requirements-dev.txt are hash-locked
                           # (pip-compile output — regenerate, don't
                           # hand-edit; see the headers in those files)

uvicorn backend.api:app --port 8000        # API (+ built frontend, if present)

cd frontend && npm ci && npm run dev       # dev UI at localhost:5173
                                           # (CORS is pre-allowed)

python -m src.cli                          # command-line front end
```

## Tests & CI

```bash
pytest                             # backend suite (tests/, fully offline —
                                   # fake transport and fake client)
ruff check src backend tests       # Python lint (+ ruff format --check)
mypy src backend                   # Python type check (permissive config)
cd frontend && npm test            # Vitest hook + component tests
npm run typecheck                  # TypeScript, no emit
npm run lint                       # eslint (flat config)
npm run build                      # production bundle
npm run test:e2e                   # Playwright smoke suite (needs the
                                   # build above + the dev Python env)
```

CI runs on GitHub Actions (`.github/workflows/ci.yml`) on pushes to
`main` and on pull requests: backend pytest on Python 3.12 (installed
from the hash-locked `requirements-dev.txt`), frontend typecheck +
test + build on Node 24, a lint job (ruff + mypy on the Python side,
eslint on the frontend), and a Playwright E2E smoke suite
(`frontend/e2e/`) against the real built app with a stub upstream.

## Deployment

One Docker image: a multi-stage build compiles the frontend in
stage 1, then the Python service runs it together with the API —
as a non-root user (`appuser`), with an exec-form command that
honours `$PORT` and a healthcheck built on Python's urllib. It
deploys to Render's free plan, auto-deploying on every push to
`main`. One caveat: the no-repeat memory and caches live
per-process, so the service runs a single worker/instance. See
[DEPLOY.md](DEPLOY.md) for the full walkthrough.

## Credits

*This project was inspired by this YouTube video:
https://youtu.be/prKGwxYQ00E?si=fGYCTsLfWcJHLPg3*
