# Single-service image: builds the frontend, then runs FastAPI,
# which serves both /api/* and the built frontend (see backend/api.py).

# --- Stage 1: build the frontend ---
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run typecheck && npm run build

# --- Stage 2: run the backend + built frontend ---
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml ./
COPY backend/requirements.txt backend/requirements.txt
COPY src/ src/
COPY backend/ backend/
RUN pip install --no-cache-dir -r backend/requirements.txt
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
