"""Generate and open a random English-language nhentai gallery.

This version uses keyless API access:
- No Authorization header or API key is required.
- A descriptive User-Agent header identifies this application.
- The application searches for English galleries through the API.
- It selects one gallery at random and opens its public website page.
- Image URLs, if needed, are built only from API-provided CDN data.
"""

import json
import random
import threading
import time
import webbrowser
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


SEARCH_URL = "https://nhentai.net/api/v2/search"
GALLERY_DETAIL_URL_TEMPLATE = "https://nhentai.net/api/v2/galleries/{gallery_id}"
CDN_URL = "https://nhentai.net/api/v2/cdn"
PUBLIC_GALLERY_URL_TEMPLATE = "https://nhentai.net/g/{gallery_id}/"

USER_AGENT = (
    "SauceMeUpRNJesus/1.0 "
    "(https://github.com/leotanxd/sauce-me-up-rnjesus)"
)

REQUEST_TIMEOUT_SECONDS = 10
MAX_RETRIES = 3
INITIAL_RETRY_DELAY_SECONDS = 2
MAX_JITTER_SECONDS = 1


class SauceGenerator:
    """Retrieves and opens a random English-language gallery."""

    def __init__(self, order_count: int = 1, browser=None):
        self.order_count = order_count
        self.browser = browser if browser is not None else webbrowser
        self._cdn_data: dict | None = None  # cached GET /api/v2/cdn response
        self._search_num_pages: int | None = None  # learned from page 1
        self._pool: list = []  # shuffled search results waiting to be served
        self._lock = threading.Lock()  # guards _pool and the lazy caches

    def _build_search_url(self, page: int = 1) -> str:
        """Build the API search URL for English-language galleries."""
        query = urlencode({"query": "language:english", "page": page})
        return f"{SEARCH_URL}?{query}"

    def _retry_delay(self, attempt: int) -> float:
        """Calculate exponential backoff with random jitter."""
        base_delay = INITIAL_RETRY_DELAY_SECONDS * (2 ** (attempt - 1))
        jitter = random.uniform(0, MAX_JITTER_SECONDS)
        return base_delay + jitter

    def _request_json(self, url: str) -> dict:
        """Request JSON data without authentication, with retries."""
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            request = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json",
                },
            )

            try:
                with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                    if response.status != 200:
                        raise RuntimeError(
                            f"API returned HTTP {response.status}: {url}"
                        )

                    return json.loads(response.read().decode("utf-8"))

            except HTTPError as error:
                status_code = error.code

                if status_code == 429 and attempt < MAX_RETRIES:
                    delay = self._retry_delay(attempt)
                    print(f"Rate limited. Retrying in {delay:.1f} seconds...")
                    time.sleep(delay)
                    last_error = error
                    continue

                if status_code == 401:
                    raise RuntimeError(
                        "The API rejected the request because authentication "
                        "is required for this endpoint."
                    ) from error

                if status_code == 403:
                    raise RuntimeError(
                        "The API refused the request. This endpoint may be "
                        "restricted or unavailable to this client."
                    ) from error

                if status_code == 404:
                    raise RuntimeError(
                        "The requested API resource could not be found."
                    ) from error

                if 500 <= status_code < 600:
                    if attempt < MAX_RETRIES:
                        delay = self._retry_delay(attempt)
                        print(
                            f"API server error {status_code}. "
                            f"Retrying in {delay:.1f} seconds..."
                        )
                        time.sleep(delay)
                        last_error = error
                        continue

                raise RuntimeError(
                    f"Could not retrieve data from the API: HTTP {status_code}"
                ) from error

            except (URLError, TimeoutError) as error:
                last_error = error

                if attempt < MAX_RETRIES:
                    delay = self._retry_delay(attempt)
                    print(f"Network issue. Retrying in {delay:.1f} seconds...")
                    time.sleep(delay)
                    continue

                raise RuntimeError(
                    f"Could not connect to the API: {error}"
                ) from error

            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise RuntimeError(
                    "The API returned data that could not be understood."
                ) from error

        raise RuntimeError(f"Could not retrieve data after retries: {last_error}")

    def _refill_pool(self) -> None:
        """Fetch one random search page and pool ALL its results.

        Caller must hold self._lock. One search call yields ~25
        galleries, so pooling cuts search traffic roughly 25x versus
        fetching a page per pick. Pages are random across the whole
        English catalogue, so picks are not limited to the newest.
        """
        if self._search_num_pages is None:
            data = self._request_json(self._build_search_url(1))
            num_pages = data.get("num_pages")
            self._search_num_pages = (
                num_pages if isinstance(num_pages, int) and num_pages > 0 else 1
            )
            results = data.get("result", [])
        else:
            page = random.randint(1, self._search_num_pages)
            data = self._request_json(self._build_search_url(page))
            results = data.get("result", [])
            if not isinstance(results, list) or not results:
                # Stale/empty page — fall back to page 1.
                data = self._request_json(self._build_search_url(1))
                results = data.get("result", [])

        if not isinstance(results, list) or not results:
            raise RuntimeError(
                "No English-language galleries were returned by the API."
            )

        pool = [g for g in results if isinstance(g, dict) and "id" in g]
        random.shuffle(pool)
        self._pool = pool

    def get_random_english_gallery(self) -> dict:
        """Return one English-language gallery from the result pool.

        The pool is refilled from a random search page only when it
        runs out, so most calls cost no network request at all.
        """
        with self._lock:
            if not self._pool:
                self._refill_pool()
            return self._pool.pop()

    def get_gallery_details(self, gallery_id: int) -> dict:
        """Optionally retrieve more information about a selected gallery."""
        detail_url = GALLERY_DETAIL_URL_TEMPLATE.format(gallery_id=gallery_id)
        return self._request_json(detail_url)

    def build_gallery_url(self, gallery: dict) -> str:
        """Create the public nhentai website link for a gallery."""
        try:
            gallery_id = int(gallery["id"])
        except (KeyError, TypeError, ValueError) as error:
            raise RuntimeError(
                "The API response did not contain a valid gallery ID."
            ) from error

        return PUBLIC_GALLERY_URL_TEMPLATE.format(gallery_id=gallery_id)

    def build_media_url(self, relative_media_path: str) -> str:
        """Build an image URL using an API-provided CDN server and path.

        Per the API v2 docs (GET /api/v2/cdn), the CDN config returns
        ``image_servers`` and ``thumb_servers`` — there is no ``servers``
        key. A full URL is one server + the path, used exactly as the
        API returned it. Thumbnail paths live on the thumb servers;
        page and cover paths live on the image servers.
        """
        if not relative_media_path:
            raise RuntimeError("The API did not provide a media path.")

        with self._lock:
            if self._cdn_data is None:
                self._cdn_data = self._request_json(CDN_URL)
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

    def open(self) -> None:
        """Find one random English gallery and open its website page."""
        try:
            gallery = self.get_random_english_gallery()
            gallery_url = self.build_gallery_url(gallery)
        except RuntimeError as error:
            print(error)
            return

        gallery_id = gallery.get("id", "Unknown")
        # Search items carry a flat english_title; a nested title dict
        # only appears on gallery DETAIL responses, not in search.
        raw_title = gallery.get("title")
        if isinstance(raw_title, dict):
            title = raw_title.get("english") or raw_title.get("pretty") or "Untitled"
        else:
            title = gallery.get("english_title") or "Untitled"

        print("Here is your random English sauce:")
        print(f"Gallery ID: {gallery_id}")
        print(f"Title: {title}")
        print(gallery_url)

        self.browser.open(gallery_url, 0, True)


class SauceApp:
    """Runs the sauce generator a chosen number of times."""

    def __init__(self, generator: SauceGenerator):
        self.generator = generator

    def run(self) -> None:
        for _ in range(self.generator.order_count):
            self.generator.open()


def main() -> None:
    generator = SauceGenerator()
    app = SauceApp(generator=generator)
    app.run()


if __name__ == "__main__":
    main()