"""Typed models for upstream API payloads, parsed once at the boundary.

All knowledge of the upstream payload shapes lives here: the title
priority (search english_title -> detail title.english ->
title.pretty), the page ordering (by page number, number-less pages
last), the media-path extraction (a path may arrive as a plain string
or as a {"path"/"url"} dict), and the language check. Callers work
with these models instead of re-walking raw dicts, so upstream shape
drift has exactly one place to be absorbed.
"""

from dataclasses import dataclass


def _as_dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _media_path(node: object) -> str | None:
    """A media path may be a plain string or a {"path"/"url"} dict."""
    if isinstance(node, str):
        return node or None
    if isinstance(node, dict):
        for key in ("path", "url"):
            value = node.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _sorted_page_paths(pages: object) -> tuple[str, ...]:
    """Page paths ordered by page number; number-less pages sort last.

    Pages without a usable path are skipped (they cannot be displayed).
    """
    if not isinstance(pages, list):
        return ()
    entries = []
    for index, page in enumerate(pages):
        if not isinstance(page, dict):
            continue
        path = _media_path(page)
        if not path:
            continue
        number = page.get("number")
        key = number if isinstance(number, int) else float("inf")
        entries.append((key, index, path))
    entries.sort(key=lambda entry: (entry[0], entry[1]))
    return tuple(path for _, _, path in entries)


@dataclass(frozen=True)
class GallerySummary:
    """One search result."""

    id: int
    english_title: str | None
    thumbnail_path: str | None
    cover_path: str | None

    @classmethod
    def from_search_item(cls, raw: object) -> "GallerySummary | None":
        """Parse one search result; None if it has no usable ID."""
        if not isinstance(raw, dict):
            return None
        try:
            gallery_id = int(raw["id"])
        except (KeyError, TypeError, ValueError):
            return None
        title = raw.get("english_title")
        return cls(
            id=gallery_id,
            english_title=title if isinstance(title, str) and title else None,
            thumbnail_path=_media_path(raw.get("thumbnail")),
            cover_path=_media_path(raw.get("cover")),
        )


@dataclass(frozen=True)
class GalleryDetail:
    """One gallery detail response, fully parsed."""

    id: int
    english_title: str | None
    pretty_title: str | None
    page_paths: tuple[str, ...]
    page_count: int | None  # length of the raw pages list, if it was one
    cover_path: str | None
    thumbnail_path: str | None
    languages: frozenset

    @classmethod
    def empty(cls, gallery_id: int) -> "GalleryDetail":
        """An all-unknown detail, used when the fetch itself failed."""
        return cls(
            id=gallery_id,
            english_title=None,
            pretty_title=None,
            page_paths=(),
            page_count=None,
            cover_path=None,
            thumbnail_path=None,
            languages=frozenset(),
        )

    @classmethod
    def from_detail(cls, raw: object, gallery_id: int) -> "GalleryDetail":
        data = _as_dict(raw.get("result", raw)) if isinstance(raw, dict) else {}
        title = _as_dict(data.get("title"))
        english = title.get("english")
        pretty = title.get("pretty")
        pages = data.get("pages")
        languages = frozenset(
            tag["name"]
            for tag in (data.get("tags") or [])
            if isinstance(tag, dict)
            and tag.get("type") == "language"
            and isinstance(tag.get("name"), str)
        )
        return cls(
            id=gallery_id,
            english_title=english if isinstance(english, str) and english else None,
            pretty_title=pretty if isinstance(pretty, str) and pretty else None,
            page_paths=_sorted_page_paths(pages),
            page_count=len(pages) if isinstance(pages, list) else None,
            cover_path=_media_path(data.get("cover")),
            thumbnail_path=_media_path(data.get("thumbnail")),
            languages=languages,
        )

    @property
    def is_english(self) -> bool | None:
        """True/False when language tags are present; None if unknown."""
        if not self.languages:
            return None
        return "english" in self.languages

    def display_title(self, summary: GallerySummary | None = None) -> str:
        """The one title priority: search title, then the detail's
        english title, then its pretty title, then a placeholder."""
        if summary is not None and summary.english_title:
            return summary.english_title
        return self.english_title or self.pretty_title or "Untitled"

    def first_media_path(self, summary: GallerySummary | None = None) -> str | None:
        """First page image, then cover, then thumbnail (the detail's
        own first, then the search result's)."""
        if self.page_paths:
            return self.page_paths[0]
        if self.cover_path:
            return self.cover_path
        if self.thumbnail_path:
            return self.thumbnail_path
        if summary is not None:
            return summary.thumbnail_path or summary.cover_path
        return None
