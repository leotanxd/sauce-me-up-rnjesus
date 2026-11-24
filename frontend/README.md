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
   `src/index.css`). The feed API only ever returns the *first* page/cover
   image of one gallery (`firstImageUrl`); the frontend renders only that
   in the feed. The rest of a gallery is available separately: when the
   user pages through a sauce with ← / →, the card fetches the full page
   list on demand from `GET /api/sauce/{id}/pages` and caches it.
2. **TikTok-like scroll** — `.sauce-feed` uses `scroll-snap-type: y mandatory`,
   every `.sauce-card` is `100dvh` with `scroll-snap-align: start`. Scroll /
   swipe / ↑ ↓ keys move one item at a time; reaching the end pre-loads more.
3. **Toggleable blur** — images start blurred (`blur(28px)`, scaled slightly
   so edges don't leak). Toggle per tap on the image, with the Reveal/Blur
   button on the right rail, or the global Blur ON/OFF switch.

While batches generate, a small loading animation (a cute anime girl
sitting and waiting, `src/components/LoadingGirl.tsx`) shows on first load
and as a centered overlay during top-ups.

## Run it

See the root `README.md` / `DEPLOY.md` for the full instructions. Short
version: run the backend (`uvicorn backend.api:app --port 8000` from the
repo root), then `npm run dev` here — http://localhost:5173, with `/api`
proxied to :8000.

In **development builds only**, if the backend is unreachable the feed
falls back to neutral demo placeholders (`src/lib/api.ts`) so the
scrolling/blur UX can be tested on its own. Production builds surface a
real error with a retry button instead.

## Layout

- `src/components/SauceFeed.tsx` — snap container, infinite loading, keys
- `src/components/SauceCard.tsx` — one full-screen item + blur toggle +
  ← / → paging through the gallery's pages (fetched lazily per card)
- `src/components/LoadingGirl.tsx` — loading animation (video chunk is
  loaded lazily; a poster frame shows instantly)
- `src/lib/api.ts` — `GET /api/sauce/next`, `/api/sauce/batch?n=`, and
  `/api/sauce/{id}/pages`; `BATCH_SIZE` lives here
- `../backend/api.py` — FastAPI wrapper around `SauceGenerator`; feed
  endpoints send the first page only, `/pages` sends the rest on demand
