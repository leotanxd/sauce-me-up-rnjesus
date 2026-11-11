import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import webbrowser


class SauceGenerator:
    RANDOM_GALLERY_API = "https://nhentai.net/api/v2/galleries/random"
    GALLERY_API = "https://nhentai.net/api/gallery/{}"
    GALLERY_URL = "https://nhentai.net/g/{}"
    USER_AGENT = (
        "SauceGenerator/1.0 "
        "(https://github.com/leojhttan/sauce-me-up-rnjesus)"
    )

    def __init__(
        self,
        order_count: int = 1,
        browser=None,
        max_attempts: int = 10,
    ):
        self.order_count = order_count
        self.browser = browser if browser is not None else webbrowser
        self.max_attempts = max_attempts

    def _get_json(self, api_url: str) -> dict:
        request = Request(api_url, headers={"User-Agent": self.USER_AGENT})
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"API returned HTTP {response.status}: {api_url}")
            return json.loads(response.read().decode("utf-8"))

    def get_random_gallery_id(self, gallery: dict) -> int:
        #gallery = self._get_json(self.RANDOM_GALLERY_API)
        return int(gallery["id"])

    def has_english_language_tag(self, metadata) -> bool:
        #metadata = self._get_json(self.GALLERY_API.format(gallery_id))
        tags = metadata["tags"]
        return any(
            tag["type"] == "language"
            and tag["name"].casefold() == "english"
            for tag in tags
        )

    def get_random_english_gallery_id(self) -> int:
        for _ in range(self.order_count):
            json_data = self._get_json(self.RANDOM_GALLERY_API)
            gallery_id = self.get_random_gallery_id(json_data)
            metadata = self.GALLERY_API.format(json_data["gallery_id"])
            
            if self.has_english_language_tag(metadata, gallery_id):
                return gallery_id

        raise RuntimeError(
            f"No English-tagged gallery found after {self.order_count} attempts"
        )

    def open(self) -> None:
        try:
            gallery_id = self.get_random_english_gallery_id()
        except (HTTPError, URLError, TimeoutError) as error:
            print(f"Could not retrieve gallery metadata: {error}")
            return
        except (KeyError, TypeError, ValueError) as error:
            print(f"The API response did not contain valid gallery data: {error}")
            return
        except RuntimeError as error:
            print(error)
            return

        gallery_url = self.GALLERY_URL.format(gallery_id)
        print(f"Gallery ID: {gallery_id}")
        print(gallery_url)
        self.browser.open(gallery_url, 0, True)


class SauceApp:
    def __init__(self, generate: SauceGenerator):
        self.generate = generate

    def run(self) -> None:
        print(f"Generating {self.generate.order_count} random English-tagged galleries...")
        for _ in range(self.generate.order_count):
            self.generate.open()


def main() -> None:
    generate = SauceGenerator()
    app = SauceApp(generate=generate)
    app.run()


if __name__ == "__main__":
    main()
