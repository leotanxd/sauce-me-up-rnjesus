"""Cache-Control policy for the single-service deployment, plus
the request-ID middleware (Package 4).

Hashed build assets are immutable; everything else the app serves
(the SPA shell, unhashed dist files) must revalidate on every load
so a deploy is never masked by a stale browser cache. /api/* is
never stamped.
"""

from src.request_context import (
    new_request_id,
    reset_request_id,
    set_request_id,
)

ASSETS_PREFIX = "/assets/"
API_PREFIX = "/api/"
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"


class CacheHeadersMiddleware:
    """Pure-ASGI: stamps Cache-Control by path class on 200s."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if path.startswith(API_PREFIX):
            await self.app(scope, receive, send)
            return
        header = IMMUTABLE if path.startswith(ASSETS_PREFIX) else REVALIDATE

        async def send_with_header(message):
            if message["type"] == "http.response.start" and message["status"] == 200:
                # Strip-then-set: nothing downstream sets Cache-Control
                # today, so this simply guarantees exactly one header
                # with the policy value (never a duplicate, never an
                # overwrite of a different policy).
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", header.encode()))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_header)


def _usable_request_id(value: str) -> bool:
    """An inbound X-Request-ID worth propagating: short printable
    ASCII. Anything else is replaced with a minted ID — the header
    is echoed back and stamped into logs, so it stays tame."""
    return 0 < len(value) <= 128 and all(32 <= ord(char) < 127 for char in value)


class RequestIdMiddleware:
    """Pure-ASGI: one request ID per HTTP request.

    Propagates a usable inbound X-Request-ID, otherwise mints one;
    stores it in the request contextvar (src.request_context) so
    log lines emitted anywhere under the request carry it, and
    stamps it on the response as X-Request-ID for the client.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = ""
        for key, value in scope.get("headers", []):
            if key.lower() == b"x-request-id":
                incoming = value.decode("latin-1")
                break
        request_id = incoming if _usable_request_id(incoming) else new_request_id()
        token = set_request_id(request_id)

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != b"x-request-id"
                ]
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_header)
        finally:
            reset_request_id(token)
