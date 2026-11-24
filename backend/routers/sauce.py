"""Feed routes: thin wrappers over SaucePicker.

Design rule (from the frontend spec): the FEED only ever receives
the first retrieval item — the first page image of each gallery. The
full page list is available only through /pages, which the frontend
calls on demand when the user pages through a sauce.
"""

from fastapi import APIRouter, Query
from pools import FeedMode

from ..picker import SaucePicker
from ..schemas import BatchOut, PagesOut, SauceOut


def create_sauce_router(picker: SaucePicker) -> APIRouter:
    router = APIRouter()

    @router.get("/api/sauce/next", response_model=SauceOut)
    def sauce_next(mode: FeedMode = Query(default=FeedMode.RANDOM)) -> SauceOut:
        # ?mode=popular draws from the API's popular-week sort
        # (currently very popular); the default ?mode=random is the
        # whole-catalogue random feed.
        return picker.next(mode=mode)

    @router.get("/api/sauce/batch", response_model=BatchOut)
    def sauce_batch(
        n: int = Query(default=3, ge=1, le=10),
        mode: FeedMode = Query(default=FeedMode.RANDOM),
    ) -> BatchOut:
        return picker.batch(n, mode=mode)

    @router.get("/api/sauce/{gallery_id}/pages", response_model=PagesOut)
    def sauce_pages(gallery_id: int) -> PagesOut:
        return picker.pages(gallery_id)

    return router
