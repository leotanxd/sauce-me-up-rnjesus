"""Builds absolute image URLs from API-provided CDN configuration.

Per the API v2 docs (GET /api/v2/cdn), the CDN config returns
``image_servers`` and ``thumb_servers`` — there is no ``servers`` key.
A full URL is one server + the path, used exactly as the API returned
it. Thumbnail paths live on the thumb servers; page and cover paths
live on the image servers.

Two Package 3 policies:

- The server for a path is chosen by a STABLE HASH of the path, so
  the same path always maps to the same host — across calls, across
  config refreshes, across restarts. (Was: a random host per call,
  which scattered one gallery's pages across mirrors and made the
  browser download identical bytes twice under different URLs.)
- The config is refreshed after a TTL instead of being cached
  forever, so a stale/dead server list can heal without a restart.
  A failed refresh serves the stale config; refreshes stay
  single-flight under the lock, so at most one config fetch is in
  flight (or spent) per TTL window no matter the load.
"""

import hashlib
import threading
import time

from src.http_client import JsonHttpClient

CDN_URL = "https://nhentai.net/api/v2/cdn"

# backend.config.Settings carries the same value as
# cdn_config_ttl_seconds and the composition root passes it in;
# this default keeps direct construction (CLI, tests) consistent.
DEFAULT_CDN_CONFIG_TTL_SECONDS = 3600.0


def _pick_server(servers: list, relative_media_path: str) -> str:
    """The one server for this path, by stable hash of the path."""
    digest = hashlib.sha256(relative_media_path.encode("utf-8")).digest()
    index = int.from_bytes(digest[:8], "big") % len(servers)
    server = servers[index]
    if not isinstance(server, str) or not server:
        raise RuntimeError("The API returned an invalid CDN server.")
    return server


class MediaUrlBuilder:
    """Turns relative media paths into absolute CDN URLs."""

    def __init__(
        self,
        http: JsonHttpClient,
        config_ttl_seconds: float = DEFAULT_CDN_CONFIG_TTL_SECONDS,
        clock=time.monotonic,
    ):
        self._http = http
        self._ttl = config_ttl_seconds
        self._clock = clock
        self._cdn_data: dict | None = None  # cached GET /api/v2/cdn response
        self._fetched_at = 0.0  # on self._clock; valid when data is set
        self._lock = threading.Lock()  # guards the CDN cache + refresh

    def _config(self, deadline: float | None = None) -> dict:
        """The CDN config, fetching or refreshing it if needed.

        The fetch happens under the lock (single-flight). Within the
        TTL the cached copy is served; past it, one refresh is
        attempted and a failure falls back to the stale copy. With
        no copy at all, a failed first fetch propagates, as before.
        """
        with self._lock:
            if (
                self._cdn_data is not None
                and self._clock() - self._fetched_at < self._ttl
            ):
                return self._cdn_data
            try:
                fresh = self._http.get_json(CDN_URL, deadline=deadline)
            except RuntimeError:
                if self._cdn_data is not None:
                    return self._cdn_data  # stale-on-error
                raise
            self._cdn_data = fresh
            self._fetched_at = self._clock()
            return fresh

    def url_for(
        self, relative_media_path: str, deadline: float | None = None
    ) -> str:
        if not relative_media_path:
            raise RuntimeError("The API did not provide a media path.")

        cdn_data = self._config(deadline=deadline)

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

        server = _pick_server(servers, relative_media_path)

        # Use the API-provided path exactly as returned.
        return f"{server.rstrip('/')}/{relative_media_path.lstrip('/')}"
