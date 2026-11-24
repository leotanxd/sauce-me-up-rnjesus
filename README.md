# Sauce Me Up, RNJesus

A TikTok-style vertical feed of random English-language sauces. Every
visit serves up different galleries, one full-screen card at a time —
no account, no setup, just scroll.

## ▶ Try it live

**[https://sauce-me-up-rnjesus.onrender.com](https://sauce-me-up-rnjesus.onrender.com)**

Click the link and the feed loads right in your browser. (It's on a
free host, so the very first load after a quiet period can take up to
a minute while the service wakes up — the waiting animation means
it's working.)

## What is this?

The backend (the client modules in `src/` — transport, search pools,
typed models, CDN URLs) draws random English-language
galleries from a catalogue of 100k+ through the nhentai API v2, picking
from random result pages so you don't just see the newest uploads.
A FastAPI app (`backend/` — `api.py` wires together config, stores, the
picker service, and the routers) serves each gallery's first
page to a dark, scroll-snapping React frontend (`frontend/`). Sauces
are generated in batches of 3, the last 300 served are remembered so
nothing repeats, and every image starts blurred until you reveal it.

## How to use it

| Action | What it does |
| --- | --- |
| Scroll / swipe, or `↑` / `↓` arrow keys | Move to the next / previous sauce |
| `→` arrow key (or the `›` button) | Next page of the sauce you're viewing |
| `←` arrow key (or the `‹` button) | Previous page of that sauce |
| **Reveal** / **Blur** button, or tap the image | Toggle the blur on the current sauce |
| **Blur: ON/OFF** switch (bottom-left) | Toggle blur for the whole feed |
| **↗ Source** button | Open the gallery at the source site |

Things to know:

- Each card shows the sauce's title, its ID (`#…`), and — once you
  start paging — a **Page X of Y** indicator.
- The first page is what loads with the feed; the rest of a gallery's
  pages are fetched only when you start paging through it.
- While sauces are generating (first load, or when you reach the end
  of the feed), a waiting animation plays in the center of the page.
- Refreshing the page starts a fresh feed with different sauces.

## Running it yourself

See [DEPLOY.md](DEPLOY.md) for the one-service Docker/Render deploy,
or run it locally:

```bash
pip install -r backend/requirements.txt
uvicorn backend.api:app --port 8000        # API (+ built frontend, if present)

cd frontend && npm install && npm run dev  # dev UI at localhost:5173
```

---

*This project was inspired by this YouTube video:
https://youtu.be/prKGwxYQ00E?si=fGYCTsLfWcJHLPg3*
