"""Feed routes: thin wrappers over SaucePicker.

Design rule (from the frontend spec): the FEED only ever receives
the first retrieval item — the first page image of each gallery. The
full page list is available only through /pages, which the frontend
calls on demand when the user pages through a sauce.
"""

from fastapi import APIRouter, Query

from ..picker import SaucePicker


def create_sauce_router(picker: SaucePicker) -> APIRouter:
    router = APIRouter()

    @router.get("/api/sauce/next")
    def sauce_next(popular: bool = Query(default=False)) -> dict:
        # popular=true draws from the API's popular-week sort
        # (currently very popular); the default is the whole-catalogue
        # random feed.
        return picker.next(popular=popular)

    @router.get("/api/sauce/batch")
    def sauce_batch(
        n: int = Query(default=3, ge=1, le=10),
        popular: bool = Query(default=False),
    ) -> dict:
        return picker.batch(n, popular=popular)

    @router.get("/api/sauce/{gallery_id}/pages")
    def sauce_pages(gallery_id: int) -> dict:
        return picker.pages(gallery_id)

    return router
