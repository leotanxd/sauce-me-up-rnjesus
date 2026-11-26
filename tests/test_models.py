"""GallerySummary / GalleryDetail parsing from recorded-shape fixtures."""

from conftest import load_fixture

from src.models import GalleryDetail, GallerySummary


def test_summary_from_search_fixture(search_page):
    summary = GallerySummary.from_search_item(search_page["result"][0])
    assert summary.id == 101
    assert summary.english_title == "First Gallery"
    assert summary.thumbnail_path == "galleries/9001/thumb.jpg"


def test_summary_null_title_degrades_to_none(search_page):
    summary = GallerySummary.from_search_item(search_page["result"][2])
    assert summary.id == 103
    assert summary.english_title is None


def test_summary_malformed_items_are_dropped():
    assert GallerySummary.from_search_item("junk") is None
    assert GallerySummary.from_search_item({}) is None
    assert GallerySummary.from_search_item({"id": "not-an-int"}) is None
    assert GallerySummary.from_search_item(None) is None


def test_detail_from_fixture(gallery_detail):
    detail = GalleryDetail.from_detail(gallery_detail, 101)
    assert detail.english_title == "First Gallery (English)"
    assert detail.pretty_title == "First Gallery"
    # Sorted by page number; the number-less page sorts last.
    assert detail.page_paths == (
        "galleries/9001/1.jpg",
        "galleries/9001/2.jpg",
        "galleries/9001/extra.jpg",
    )
    assert detail.page_count == 3
    assert detail.cover_path == "galleries/9001/cover.jpg"
    assert detail.thumbnail_path == "galleries/9001/thumb.jpg"
    assert detail.languages == frozenset({"english", "translated"})


def test_detail_result_wrapper_is_unwrapped(gallery_detail):
    detail = GalleryDetail.from_detail({"result": gallery_detail}, 101)
    assert detail.english_title == "First Gallery (English)"
    assert detail.page_count == 3


def test_detail_strip_gallery_pages_pass_through_verbatim():
    # Insurance for the strip (webtoon) rendering fix: the backend
    # already serves these galleries correctly — the fixture
    # mirrors gallery 491558's real payload shape, trimmed to 6
    # pages (two normal 300x420, one 750x400 landscape, three
    # 720-wide strips up to 720x17404) and listed out of order.
    # The parser must return every page path in page-number order
    # and count the raw list — never collapsing or dropping the
    # strip pages.
    raw = load_fixture("gallery_detail_strips.json")
    detail = GalleryDetail.from_detail(raw, 491558)
    assert detail.page_paths == (
        "galleries/2798745/1.jpg",
        "galleries/2798745/2.jpg",
        "galleries/2798745/3.jpg",
        "galleries/2798745/4.jpg",
        "galleries/2798745/5.jpg",
        "galleries/2798745/6.jpg",
    )
    assert detail.page_count == len(raw["pages"]) == 6
    assert detail.first_media_path() == "galleries/2798745/1.jpg"


def test_is_english_verdicts(gallery_detail):
    assert GalleryDetail.from_detail(gallery_detail, 101).is_english is True

    japanese = GalleryDetail.from_detail(
        {"tags": [{"type": "language", "name": "japanese"}]}, 5
    )
    assert japanese.is_english is False

    untagged = GalleryDetail.from_detail({"tags": []}, 5)
    assert untagged.is_english is None


def test_display_title_priority(gallery_detail, search_page):
    detail = GalleryDetail.from_detail(gallery_detail, 101)
    summary = GallerySummary.from_search_item(search_page["result"][0])
    # Search title wins over the detail's own titles.
    assert detail.display_title(summary) == "First Gallery"
    assert detail.display_title() == "First Gallery (English)"

    pretty_only = GalleryDetail.from_detail({"title": {"pretty": "Only Pretty"}}, 5)
    assert pretty_only.display_title() == "Only Pretty"
    assert GalleryDetail.empty(5).display_title() == "Untitled"


def test_first_media_path_priority(gallery_detail, search_page):
    detail = GalleryDetail.from_detail(gallery_detail, 101)
    assert detail.first_media_path() == "galleries/9001/1.jpg"

    no_pages = GalleryDetail.from_detail(
        {"cover": {"path": "c.jpg"}, "thumbnail": {"path": "t.jpg"}, "pages": []},
        5,
    )
    assert no_pages.first_media_path() == "c.jpg"

    coverless = GalleryDetail.from_detail({"thumbnail": {"path": "t.jpg"}}, 5)
    assert coverless.first_media_path() == "t.jpg"

    summary = GallerySummary.from_search_item(search_page["result"][0])
    assert GalleryDetail.empty(5).first_media_path(summary) == (
        "galleries/9001/thumb.jpg"
    )
    assert GalleryDetail.empty(5).first_media_path() is None


def test_detail_malformed_inputs_degrade_instead_of_raising():
    for raw in (None, "junk", [], {"title": "not-a-dict", "pages": "nope"}):
        detail = GalleryDetail.from_detail(raw, 9)
        assert detail.id == 9
        assert detail.english_title is None
        assert detail.page_paths == ()
        assert detail.page_count is None
        assert detail.is_english is None


def test_detail_empty_factory():
    detail = GalleryDetail.empty(9)
    assert detail.page_count is None
    assert detail.languages == frozenset()


def test_fixtures_load():
    # Guards the fixture files themselves against accidental edits.
    assert load_fixture("search_page.json")["num_pages"] == 1234
