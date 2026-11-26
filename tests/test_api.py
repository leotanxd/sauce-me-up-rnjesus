"""API contract: the app assembled from the router factories + a stub
picker (create_app() itself builds a real upstream client, so it is
only smoke-tested for construction, never called through)."""

import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.api import create_app
from backend.routers.meta import build_health, create_meta_router
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


@pytest.mark.parametrize(
    "url",
    [
        "/api/sauce/0/pages",  # IDs start at 1
        "/api/sauce/-5/pages",  # negative is a client bug, not a lookup
        "/api/sauce/100000001/pages",  # beyond the generous ceiling
    ],
)
def test_pages_rejects_out_of_bounds_ids_without_calling_the_picker(
    client, stub, url
):
    # Package 2: absurd gallery IDs are 422 at the route — no picker
    # call, so no upstream request is spent on them.
    assert client.get(url).status_code == 422
    assert stub.calls == []


def test_pages_accepts_an_in_bounds_id(client, stub):
    response = client.get("/api/sauce/5/pages")
    assert response.status_code == 200
    assert stub.calls[-1] == ("pages", 5)


def test_create_app_constructs_without_network():
    app = create_app()
    assert app.title.startswith("Sauce Me Up")


def _health_client(last_success_at, fresh_seconds=900.0):
    app = FastAPI()
    app.include_router(
        create_meta_router(lambda: build_health(last_success_at, fresh_seconds))
    )
    return TestClient(app, raise_server_exceptions=False)


def test_health_unknown_before_any_upstream_success():
    response = _health_client(None).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "upstream": {"lastSuccessAt": None, "upstreamStatus": "unknown"},
    }


def test_health_ok_after_a_recent_success():
    response = _health_client(time.time()).get("/api/health")
    body = response.json()
    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["upstream"]["upstreamStatus"] == "ok"
    assert body["upstream"]["lastSuccessAt"].endswith("Z")


def test_health_stale_after_the_freshness_window_but_still_200():
    response = _health_client(time.time() - 1000, fresh_seconds=900.0).get(
        "/api/health"
    )
    assert response.status_code == 200  # upstream state is never app death
    assert response.json()["upstream"]["upstreamStatus"] == "stale"


def test_health_reports_the_cooldown_only_while_it_is_active():
    # Package 2: an active 429/403 cooldown is informational health
    # data; the key appears only while a cooldown is in effect.
    body = build_health(None, 900.0, cooldown_until=time.time() + 120)
    assert body["upstream"]["cooldownUntil"].endswith("Z")
    assert "cooldownUntil" not in build_health(None, 900.0)["upstream"]
