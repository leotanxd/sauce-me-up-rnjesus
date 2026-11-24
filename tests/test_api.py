"""API contract: the app assembled from the router factories + a stub
picker (create_app() itself builds a real upstream client, so it is
only smoke-tested for construction, never called through)."""

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.routers.meta import create_meta_router
from backend.routers.sauce import create_sauce_router
from backend.schemas import BatchOut, PagesOut, SauceOut
from src.pools import FeedMode


class StubPicker:
    """Records calls; returns fixed contract-shaped responses."""

    def __init__(self):
        self.calls: list = []
        self.fail_next = False

    def next(self, mode=FeedMode.RANDOM, deadline=None):
        self.calls.append(("next", mode))
        if self.fail_next:
            raise HTTPException(status_code=502, detail="Upstream returned no galleries.")
        return SauceOut(
            id=7,
            title="Stub Gallery",
            url="https://nhentai.net/g/7/",
            first_image_url="https://cdn.example/galleries/7/1.jpg",
            page_count=12,
        )

    def batch(self, n, mode=FeedMode.RANDOM):
        self.calls.append(("batch", n, mode))
        items = [
            SauceOut(
                id=100 + i,
                title=f"Stub {i}",
                url=f"https://nhentai.net/g/{100 + i}/",
                first_image_url=None,
                page_count=None,
            )
            for i in range(n)
        ]
        return BatchOut(items=items, errors=0)

    def pages(self, gallery_id):
        self.calls.append(("pages", gallery_id))
        return PagesOut(id=gallery_id, count=2, images=["a.jpg", "b.jpg"])


@pytest.fixture
def stub():
    return StubPicker()


@pytest.fixture
def client(stub):
    app = FastAPI()
    app.include_router(create_sauce_router(stub))
    app.include_router(create_meta_router())
    return TestClient(app, raise_server_exceptions=False)


def test_health_shape(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_next_wire_keys_are_exactly_the_contract(client):
    response = client.get("/api/sauce/next")
    assert response.status_code == 200
    assert set(response.json()) == {
        "id",
        "title",
        "url",
        "firstImageUrl",
        "pageCount",
    }
    assert response.json()["firstImageUrl"].endswith("1.jpg")
    assert response.json()["pageCount"] == 12


def test_batch_passes_mode_through(client, stub):
    response = client.get("/api/sauce/batch?n=3&mode=popular")
    assert response.status_code == 200
    assert set(response.json()) == {"items", "errors"}
    assert len(response.json()["items"]) == 3
    assert stub.calls[-1] == ("batch", 3, FeedMode.POPULAR)


@pytest.mark.parametrize("url", ["/api/sauce/batch?mode=banana", "/api/sauce/batch?n=0", "/api/sauce/batch?n=11"])
def test_invalid_query_params_are_422(client, url):
    assert client.get(url).status_code == 422


def test_unknown_api_path_is_json_404(client):
    response = client.get("/api/definitely-not-a-route")
    assert response.status_code == 404
    assert response.json()["detail"] == "Not found."


def test_picker_502_surfaces(client, stub):
    stub.fail_next = True
    assert client.get("/api/sauce/next").status_code == 502


def test_create_app_constructs_without_network():
    app = create_app()
    assert app.title.startswith("Sauce Me Up")


