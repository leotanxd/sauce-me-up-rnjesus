"""Backwards-compatible shim for the pre-refactor module layout.

The implementation now lives in small focused modules:
- http_client.py — retrying JSON transport with deadlines
- cdn.py         — MediaUrlBuilder (CDN image URLs)
- pools.py       — SearchPool (per-mode result pools)
- models.py      — GallerySummary / GalleryDetail (parsed payloads)
- client.py      — NhentaiClient (the facade the backend uses)
- cli.py         — the command-line entry point

This module re-exports the old names so existing imports keep working.
"""

import webbrowser

from src.client import NhentaiClient
from src.errors import ResourceNotFoundError

__all__ = ["SauceGenerator", "ResourceNotFoundError"]


class SauceGenerator(NhentaiClient):
    """The old combined class, kept as a compatible facade.

    Historically this also carried the CLI's concerns (order_count,
    browser, open()); those now live in cli.py, but the attributes are
    preserved here so old call sites keep working.
    """

    def __init__(self, order_count: int = 1, browser=None, **kwargs):
        super().__init__(**kwargs)
        self.order_count = order_count
        self.browser = browser if browser is not None else webbrowser

    def open(self) -> None:
        from src.cli import open_gallery

        open_gallery(self, self.browser)
