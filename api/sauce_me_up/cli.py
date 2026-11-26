"""Command-line entry point: print and open random English galleries.

This is the only module that touches a web browser; the web backend
uses client.NhentaiClient directly.
"""

import webbrowser

from sauce_me_up.upstream.client import NhentaiClient


def open_gallery(client: NhentaiClient, browser) -> None:
    """Find one random English gallery and open its website page."""
    try:
        gallery = client.get_random_english_gallery()
        gallery_url = client.build_gallery_url(gallery)
    except RuntimeError as error:
        print(error)
        return

    # The title priority now lives on the models (models.py); with no
    # detail fetched, the search result's english_title is the source.
    title = gallery.english_title or "Untitled"

    print("Here is your random English sauce:")
    print(f"Gallery ID: {gallery.id}")
    print(f"Title: {title}")
    print(gallery_url)

    browser.open(gallery_url, 0, True)


class SauceApp:
    """Runs the sauce generator a chosen number of times."""

    def __init__(self, client: NhentaiClient, browser=None, order_count: int = 1):
        self.client = client
        self.browser = browser if browser is not None else webbrowser
        self.order_count = order_count

    def run(self) -> None:
        for _ in range(self.order_count):
            open_gallery(self.client, self.browser)


def main() -> None:
    app = SauceApp(client=NhentaiClient())
    app.run()


if __name__ == "__main__":
    main()
