# Single-service image: builds the frontend, then runs FastAPI,
# which serves both /api/* and the built frontend (see backend/api.py).

# --- Stage 1: build the frontend ---
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: run the backend + built frontend ---
FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY src/ src/
COPY backend/ backend/
COPY --from=frontend-build /build/dist frontend/dist

# Render (and most hosts) set $PORT; default to 8000 locally.
CMD ["sh", "-c", "uvicorn backend.api:app --host 0.0.0.0 --port ${PORT:-8000}"]
