"""The upstream API client: a thin facade over transport, CDN, pools.

Composes JsonHttpClient (retries/deadlines), MediaUrlBuilder (CDN
URLs), and SearchPool (per-mode result pools), and returns typed
models (models.py) parsed once at the boundary.
"""

from cdn import MediaUrlBuilder
from http_client import JsonHttpClient
from models import GalleryDetail, GallerySummary
from pools import FeedMode, SearchPool

GALLERY_DETAIL_URL_TEMPLATE = "https://nhentai.net/api/v2/galleries/{gallery_id}"
PUBLIC_GALLERY_URL_TEMPLATE = "https://nhentai.net/g/{gallery_id}/"


class NhentaiClient:
    """Retrieves random English-language galleries from the API."""

    def __init__(
        self,
        http: JsonHttpClient | None = None,
        media: MediaUrlBuilder | None = None,
        pool: SearchPool | None = None,
    ):
        self._http = http if http is not None else JsonHttpClient()
        self._media = media if media is not None else MediaUrlBuilder(self._http)
        self._pool = pool if pool is not None else SearchPool(self._http)

    def get_random_english_gallery(
        self, deadline: float | None = None, mode: FeedMode = FeedMode.RANDOM
    ) -> GallerySummary:
        """Return one English-language gallery from the result pool.

        The pool is refilled from a random search page only when it
        runs out, so most calls cost no network request at all. With
        mode=FeedMode.POPULAR the pool draws from the API's
        popular-week sort (currently very popular) instead of the
        whole catalogue.
        """
        return self._pool.next(mode=mode, deadline=deadline)

    def get_gallery_details(
        self, gallery_id: int, deadline: float | None = None
    ) -> GalleryDetail:
        """Retrieve and parse the detail record for one gallery."""
        detail_url = GALLERY_DETAIL_URL_TEMPLATE.format(gallery_id=gallery_id)
        raw = self._http.get_json(detail_url, deadline=deadline)
        return GalleryDetail.from_detail(raw, gallery_id)

    def build_media_url(
        self, relative_media_path: str, deadline: float | None = None
    ) -> str:
        """Build an absolute image URL for a relative media path."""
        return self._media.url_for(relative_media_path, deadline=deadline)

    def build_gallery_url(self, gallery: GallerySummary | int) -> str:
        """Create the public nhentai website link for a gallery."""
        gallery_id = gallery.id if isinstance(gallery, GallerySummary) else gallery
        try:
            gallery_id = int(gallery_id)
        except (TypeError, ValueError) as error:
            raise RuntimeError(
                "The API response did not contain a valid gallery ID."
            ) from error
        return PUBLIC_GALLERY_URL_TEMPLATE.format(gallery_id=gallery_id)
