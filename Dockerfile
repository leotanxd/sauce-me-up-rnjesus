# Single-service image: builds the frontend, then runs FastAPI,
# which serves both /api/* and the built frontend (see backend/api.py).

# Base images are digest-pinned (Package 5) so a rebuild later
# cannot silently pick up a different image under the same tag.
# Refresh procedure: see DEPLOY.md ("Base-image digests").

# --- Stage 1: build the frontend ---
FROM node:24-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run typecheck && npm run build

# --- Stage 2: run the backend + built frontend ---
FROM python:3.12-slim@sha256:191083cdf6c7bda8c76158983163ead5d5cf7b77cf3033e805bb0f5296f51b4b
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml ./
# Runtime dependencies come from the hash-locked requirements.txt
# (generated from pyproject.toml — see the file's header), so the
# installed package set is bit-reproducible; the project itself is
# then installed with --no-deps on top.
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY src/ src/
COPY backend/ backend/
RUN pip install --no-cache-dir --no-deps -e .
COPY --from=frontend-build /build/dist frontend/dist

# Run as a non-root user (the app writes nothing to disk at runtime).
RUN useradd --create-home --uid 10001 appuser
USER appuser

# Render (and most hosts) set $PORT; default to 8000 locally. `exec`
# replaces the shell with uvicorn as PID 1, so SIGTERM reaches the
# server directly for a graceful shutdown.
CMD ["sh", "-c", "exec uvicorn backend.api:app --host 0.0.0.0 --port ${PORT:-8000}"]

# The slim image has no curl/wget — probe with the interpreter itself.
# Checks only that the app is up (status == "ok"), never upstream
# state: an upstream outage must not mark the container unhealthy.
# (Render ignores Dockerfile HEALTHCHECK and does its own HTTP checks.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import json,os,sys,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/api/health', timeout=4)); sys.exit(0 if d.get('status')=='ok' else 1)"
