# Frontend — Sauce Me Up, RNJesus

Dark, TikTok-like vertical feed for `src/sauce_generator.py`, scaffolded
from the **Film Camera App Scroll Landing Page** template (Shutter Roll)
by Kedhareswer Naidu — MIT, via 21st.dev:
https://21st.dev/@kedhareswer/templates/film-camera-app-scroll-landing-page

What was kept from the template: the Vite + React + Tailwind v4 stack and
its core mechanic — scrolling dives into *one* print until it fills the
screen, framed like a phone. What was changed: the landing page, tabletop,
film stocks and night sections are gone; that one-item mechanic is repeated
as an infinite feed.

## The 3 requirements

1. **Dark, first item only** — true-black theme (`bg-black`, dark tokens in
   `src/index.css`). The backend API only ever returns the *first* page/cover
   image of one gallery (`firstImageUrl`); the frontend renders only that.
2. **TikTok-like scroll** — `.sauce-feed` uses `scroll-snap-type: y mandatory`,
   every `.sauce-card` is `100dvh` with `scroll-snap-align: start`. Scroll /
   swipe / ↑ ↓ keys move one item at a time; reaching the end pre-loads more.
3. **Toggleable blur** — images start blurred (`blur(28px)`, scaled slightly
   so edges don't leak). Toggle per tap on the image, with the Reveal/Blur
   button on the right rail, or the global Blur ON/OFF switch.

## Run it

```bash
# 1) Backend API (new terminal, from the repo root)
pip install -r backend/requirements.txt
uvicorn backend.api:app --port 8000

# 2) Frontend (this folder)
npm install
npm run dev        # http://localhost:5173  (/api is proxied to :8000)
```

With no backend running, the feed falls back to neutral demo placeholders
(`src/lib/api.ts`) so the scrolling/blur UX can be tested on its own.

## Layout

- `src/components/SauceFeed.tsx` — snap container, infinite loading, keys
- `src/components/SauceCard.tsx` — one full-screen item + blur toggle
- `src/lib/api.ts` — `GET /api/sauce/next` and `/api/sauce/batch?n=`
- `../backend/api.py` — FastAPI wrapper around `SauceGenerator`; it does
  the first-page extraction and never sends other pages to the client
