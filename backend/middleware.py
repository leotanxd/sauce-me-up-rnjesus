"""Cache-Control policy for the single-service deployment.

Hashed build assets are immutable; everything else the app serves
(the SPA shell, unhashed dist files) must revalidate on every load
so a deploy is never masked by a stale browser cache. /api/* is
never stamped.
"""

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
                    (k, v) for k, v in message.get("headers", [])
                    if k.lower() != b"cache-control"
                ]
                headers.append((b"cache-control", header.encode()))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_header)
