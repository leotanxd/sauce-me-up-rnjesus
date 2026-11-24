"""SaucePicker: the pick orchestration service.

Owns the feed's core policy: draw from the client, skip anything
served recently, verify English against the detail's language tags
(re-rolling non-English picks), shape the feed response (first page
image + total page count only — full page lists leave only through
pages()), and map upstream failures to HTTP errors with generic
client-facing text. All state arrives by injection (client, stores,
settings), so the policy is testable without HTTP.
"""

import logging
import time

from fastapi import HTTPException

from errors import ResourceNotFoundError
from models import GalleryDetail

from .config import Settings
from .stores import DetailCache, RecentServedStore

logger = logging.getLogger(__name__)


class SaucePicker:
    def __init__(
        self,
        client,
        recent: RecentServedStore,
        details: DetailCache,
        settings: Settings,
    ):
        self._client = client
        self._recent = recent
        self._details = details
        self._settings = settings

    def _get_detail(
        self, gallery_id: int, deadline: float | None = None
    ) -> GalleryDetail:
        hit = self._details.get(gallery_id)
        if hit is not None:
            return hit
        detail = self._client.get_gallery_details(gallery_id, deadline=deadline)
        self._details.put(gallery_id, detail)
        return detail

    def next(self, popular: bool = False, deadline: float | None = None) -> dict:
        # The search already filters language:english; still, verify
        # each pick against its detail tags and re-roll a non-English
        # result, so what the API returns — and the frontend displays —
        # is English sauce. Picks also skip anything served recently.
        # The whole sequence runs under the store's lock so it is
        # atomic, and it gives up at the deadline instead of hanging.
        if deadline is None:
            deadline = time.monotonic() + self._settings.pick_budget_seconds

        with self._recent.lock:
            for _attempt in range(8):
                if time.monotonic() > deadline:
                    break
                try:
                    gallery = self._client.get_random_english_gallery(
                        deadline=deadline, popular=popular
                    )
                    gallery_id = gallery.id
                except Exception as error:  # upstream failure / bad payload
                    logger.warning("Pick failed: %s", error)
                    raise HTTPException(
                        status_code=502, detail=self._settings.upstream_502_text
                    ) from error

                if gallery_id in self._recent:
                    continue  # already served recently — pick another

                detail = GalleryDetail.empty(gallery_id)
                try:
                    detail = self._get_detail(gallery_id, deadline=deadline)
                except Exception:
                    # Details are optional; the search result may
                    # suffice. Accepted on the search filter alone —
                    # visible in logs so silent degradation is noticed.
                    logger.warning(
                        "Serving gallery %s without detail verification.",
                        gallery_id,
                    )

                if detail.is_english is False:
                    continue  # not English — pick another gallery

                first_path = detail.first_media_path(gallery)
                first_image_url: str | None = None
                if first_path:
                    if first_path.startswith(("http://", "https://")):
                        first_image_url = first_path
                    else:
                        try:
                            first_image_url = self._client.build_media_url(
                                first_path, deadline=deadline
                            )
                        except Exception:
                            first_image_url = None

                self._recent.remember(gallery_id)
                return {
                    "id": gallery_id,
                    # Title priority lives on the models: search
                    # english_title, then detail title.english, then
                    # title.pretty (last resort), then "Untitled".
                    "title": detail.display_title(gallery),
                    "url": self._client.build_gallery_url(gallery),
                    # ONLY the first retrieval item. No pages[] here.
                    "firstImageUrl": first_image_url,
                    # Total page count comes free from the detail
                    # already fetched for verification — the feed
                    # shows "Page 1 of N" without page URLs ever
                    # leaving the /pages endpoint.
                    "pageCount": detail.page_count,
                }

        raise HTTPException(
            status_code=502,
            detail="Could not find a new English-language gallery in time. Please retry.",
        )

    def batch(self, n: int, popular: bool = False) -> dict:
        # One overall deadline for the batch: return what was
        # generated in time rather than hanging. (The default n at the
        # route mirrors the frontend's BATCH_SIZE in
        # frontend/src/lib/api.ts — keep them in step.)
        deadline = time.monotonic() + self._settings.batch_budget_seconds
        items, errors = [], 0
        for _ in range(n):
            if time.monotonic() > deadline:
                errors += 1
                break
            try:
                items.append(self.next(deadline=deadline, popular=popular))
            except HTTPException:
                errors += 1
        if not items:
            raise HTTPException(
                status_code=502, detail="Upstream returned no galleries."
            )
        return {"items": items, "errors": errors}

    def pages(self, gallery_id: int) -> dict:
        """All page image URLs for one gallery, in page order.

        The feed itself only ever receives the first page (see next /
        batch). This exists for explicit in-sauce browsing: the
        frontend calls it only when the user starts paging through a
        sauce. URLs are built exactly as the API v2 docs prescribe: a
        CDN image server + the page's path, used verbatim.
        """
        deadline = time.monotonic() + self._settings.pick_budget_seconds
        try:
            detail = self._get_detail(gallery_id, deadline=deadline)
        except ResourceNotFoundError as error:
            raise HTTPException(
                status_code=404, detail="Gallery not found."
            ) from error
        except Exception as error:
            logger.warning("Detail fetch for %s failed: %s", gallery_id, error)
            raise HTTPException(
                status_code=502, detail=self._settings.upstream_502_text
            ) from error

        # Page paths arrive pre-sorted from the model (by page number,
        # number-less pages last) — the one ordering definition.
        urls: list[str] = []
        for path in detail.page_paths:
            try:
                urls.append(
                    self._client.build_media_url(path, deadline=deadline)
                )
            except Exception as error:
                # All-or-nothing: a silently dropped middle page would
                # shift every later "Page X of Y" label off the truth.
                logger.warning(
                    "Page URL build failed for gallery %s: %s", gallery_id, error
                )
                raise HTTPException(
                    status_code=502, detail=self._settings.upstream_502_text
                ) from error

        if not urls:
            # Fallback: at least the first page/cover, as the feed gets.
            first_path = detail.first_media_path()
            if first_path:
                try:
                    urls.append(
                        self._client.build_media_url(first_path, deadline=deadline)
                    )
                except Exception:
                    pass
        if not urls:
            raise HTTPException(
                status_code=502, detail="No page images available."
            )
        return {"id": gallery_id, "count": len(urls), "images": urls}
