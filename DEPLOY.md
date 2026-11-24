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
- The no-repeat memory, search-result pool, and caches are **per
  process**: keep the service at one uvicorn worker / one instance, or
  the "no repeats" window fragments across processes.

## Option B — the same Docker image anywhere else

```bash
docker build -t sauce-me-up .
docker run -p 8000:8000 -e PORT=8000 sauce-me-up
# http://localhost:8000
```

Works on any Docker host (a VPS, Fly.io, Koyeb, Google Cloud Run, …).

## First live check

Open the URL, then `https://<your-url>/api/health` should return
`{"status":"ok"}`. If the feed shows an error with a retry button, the
backend's upstream calls are failing from that host — check the service
logs first. (Demo placeholders exist only in development builds.)
