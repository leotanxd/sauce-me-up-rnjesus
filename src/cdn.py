"""Builds absolute image URLs from API-provided CDN configuration.

Per the API v2 docs (GET /api/v2/cdn), the CDN config returns
``image_servers`` and ``thumb_servers`` — there is no ``servers`` key.
A full URL is one server + the path, used exactly as the API returned
it. Thumbnail paths live on the thumb servers; page and cover paths
live on the image servers. The CDN config is fetched once and cached.
"""

import random
import threading

from src.http_client import JsonHttpClient

CDN_URL = "https://nhentai.net/api/v2/cdn"


class MediaUrlBuilder:
    """Turns relative media paths into absolute CDN URLs."""

    def __init__(self, http: JsonHttpClient):
        self._http = http
        self._cdn_data: dict | None = None  # cached GET /api/v2/cdn response
        self._lock = threading.Lock()  # guards the lazy CDN cache

    def url_for(
        self, relative_media_path: str, deadline: float | None = None
    ) -> str:
        if not relative_media_path:
            raise RuntimeError("The API did not provide a media path.")

        with self._lock:
            if self._cdn_data is None:
                self._cdn_data = self._http.get_json(CDN_URL, deadline=deadline)
            cdn_data = self._cdn_data

        filename = relative_media_path.rsplit("/", 1)[-1]
        stem = filename.split(".", 1)[0]
        is_thumbnail = "thumb" in filename or (
            stem.endswith("t") and stem[:-1].isdigit()
        )

        if is_thumbnail:
            candidates = [
                cdn_data.get("thumb_servers"),
                cdn_data.get("image_servers"),
            ]
        else:
            candidates = [
                cdn_data.get("image_servers"),
                cdn_data.get("thumb_servers"),
            ]

        servers = next(
            (s for s in candidates if isinstance(s, list) and s), None
        )
        if not servers:
            raise RuntimeError("The API did not provide an available CDN server.")

        server = random.choice(servers)

        if not isinstance(server, str) or not server:
            raise RuntimeError("The API returned an invalid CDN server.")

        # Use the API-provided path exactly as returned.
        return f"{server.rstrip('/')}/{relative_media_path.lstrip('/')}"
