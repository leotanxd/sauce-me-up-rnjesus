"""Health check and the JSON-404 catch-all for unmatched /api/* paths."""

from fastapi import APIRouter, HTTPException


def create_meta_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    # Any /api/* path that matched no earlier route is a client bug —
    # answer with a JSON 404 instead of the SPA's index.html (which
    # the static mount would otherwise serve with a misleading 200).
    # This router must be included AFTER the real API routers.
    @router.api_route(
        "/api/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    )
    def api_not_found(path: str) -> dict:
        raise HTTPException(status_code=404, detail="Not found.")

    return router
