# Sauce Me Up, RNJesus

A TikTok-style vertical feed of random English-language sauces — or
the currently popular ones, if you'd rather. Every visit serves up
different galleries, one full-screen card at a time — no account, no
setup, just scroll.

## ▶ Try it live

**[https://sauce-me-up-rnjesus.onrender.com](https://sauce-me-up-rnjesus.onrender.com)**

Click the link and the feed loads right in your browser. (It's on a
free host, so the very first load after a quiet period can take up to
a minute while the service wakes up — the waiting animation means
it's working.)

## Features

- **Random | Popular modes** — draw from the whole catalogue, or from
  what's popular this week.
- **No repeats within a session** — the last 300 sauces served are
  remembered, so scrolling never loops back on itself.
- **Batches of 3, generated concurrently** — the feed tops itself up
  as you approach the end, so there's always another card.
- **Blur on by default** — every image starts blurred; tap the image
  (or the Blur switch) to show it, per card or for the whole feed.
- **In-gallery paging three ways** — the ‹ › buttons, the ← → arrow
  keys, or a horizontal swipe on the image.
- **Page X of Y, always shown** — every card displays its page
  indicator from the moment it loads.
- **Condensed titles on small screens** — long titles shrink to a few
  words; tap to expand the full title in a narrow panel, tap again
  to collapse.
- **Dim mode** — one toggle hides every button and caption, leaving
  just the image (and the Dim toggle itself, so you can get back).
- **Thumb-sized controls** — the feed's main buttons (paging ‹ ›,
  ↗ Source, Random | Popular, Blur, Dim, and Retry) are at
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
| **Blur: ON/OFF** switch (bottom-left) | Toggle blur for the whole feed |
| **Dim: ON/OFF** toggle (bottom-left) | Hide / show all buttons and text |
| Tap the title (small screens) | Expand a condensed title; tap again to collapse |
| **↗ Source** button | Open the gallery at the source site |

Things to know:

- Each card shows the sauce's title, its ID (`#…`), and a
  **Page X of Y** indicator.
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
  refreshing starts a fresh feed with different sauces.

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
  - `stores` — the no-repeat window (last 300 served) and the
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
- **`frontend/`** — Vite + React + Tailwind. All state lives in
  hooks — `useSauceFeed` (feed, modes, blur, dim), `useGalleryPages`
  (per-card paging), `useHorizontalSwipe` (swipe paging) — and the
  components are layout only. The feed windows rendering to the
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

Prerequisites: Python ≥ 3.11 and Node 20.

```bash
pip install -e ".[test]"   # the package plus test deps (pytest, httpx)
                           # runtime only: pip install -e .
                           # (backend/requirements.txt does the same)

uvicorn backend.api:app --port 8000        # API (+ built frontend, if present)

cd frontend && npm ci && npm run dev       # dev UI at localhost:5173
                                           # (CORS is pre-allowed)

python -m src.cli                          # command-line front end
```

## Tests & CI

```bash
pytest                             # backend suite (tests/, fully offline —
                                   # fake transport and fake client)
cd frontend && npm test            # Vitest hook + component tests
npm run typecheck                  # TypeScript, no emit
npm run build                      # production bundle
```

CI runs on GitHub Actions (`.github/workflows/ci.yml`) on pushes to
`main` and on pull requests, with two jobs: backend pytest on
Python 3.12, and frontend typecheck + test + build on Node 20.

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
