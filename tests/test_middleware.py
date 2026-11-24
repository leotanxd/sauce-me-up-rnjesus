"""CacheHeadersMiddleware around a dummy ASGI app."""

import asyncio

from backend.middleware import IMMUTABLE, REVALIDATE, CacheHeadersMiddleware


def _dummy_app(status=200, headers=()):
    async def app(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": list(headers),
            }
        )
        await send({"type": "http.response.body", "body": b"ok"})

    return app


def _run(app, path):
    messages = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        messages.append(message)

    scope = {"type": "http", "method": "GET", "path": path, "headers": []}
    asyncio.run(CacheHeadersMiddleware(app)(scope, receive, send))
    return messages


def _cache_control_values(messages):
    start = next(m for m in messages if m["type"] == "http.response.start")
    return [
        value.decode()
        for key, value in start["headers"]
        if key.lower() == b"cache-control"
    ]


def test_assets_get_immutable():
    assert _cache_control_values(_run(_dummy_app(), "/assets/index-abc.js")) == [
        IMMUTABLE
    ]


def test_spa_shell_revalidates():
    assert _cache_control_values(_run(_dummy_app(), "/")) == [REVALIDATE]
    assert _cache_control_values(_run(_dummy_app(), "/index.html")) == [
        REVALIDATE
    ]


def test_api_paths_are_never_stamped():
    assert _cache_control_values(_run(_dummy_app(), "/api/health")) == []


def test_non_200_gets_no_header():
    assert _cache_control_values(_run(_dummy_app(status=404), "/")) == []


def test_existing_cache_control_is_replaced_not_duplicated():
    app = _dummy_app(headers=[(b"cache-control", b"max-age=0")])
    assert _cache_control_values(_run(app, "/")) == [REVALIDATE]
