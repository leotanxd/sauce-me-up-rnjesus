"""Request IDs (Package 4): one ID per HTTP request, on the
response and in the logs.

The ID lives in a contextvar set by the backend's request-ID
middleware. Sync routes run on Starlette's threadpool, which copies
the context into the worker thread, so code anywhere under a
request — picker, pools, HTTP client — reads the same ID without it
being threaded through every call signature. Work the picker fans
out to its own executor (batch picks) copies the context explicitly
at submit time; see SaucePicker.batch.

Log correlation: RequestIdLogFilter is attached to the loggers that
emit during a request (picker, pools, HTTP client). It stamps the
record with the ID and prefixes the message, so ANY handler format
— uvicorn's default included — prints it, and a reader can match a
log line to the X-Request-ID a client saw. Only the ID is ever
added: no titles, no URLs, nothing about what was served.
"""

import contextvars
import logging
import uuid

_request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "request_id", default=None
)


def new_request_id() -> str:
    return uuid.uuid4().hex


def set_request_id(request_id: str):
    """Set the current request ID; returns the reset token."""
    return _request_id.set(request_id)


def reset_request_id(token) -> None:
    _request_id.reset(token)


def get_request_id() -> str | None:
    return _request_id.get()


class RequestIdLogFilter(logging.Filter):
    """Prefixes log records with the current request ID, if any.

    Records emitted outside a request (startup, warm-up, background
    refills after their request ended) pass through unstamped.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        request_id = _request_id.get()
        record.request_id = request_id
        # Guard against double-stamping if a record ever passes
        # more than one filtered logger.
        if (
            request_id
            and isinstance(record.msg, str)
            and not getattr(record, "_request_id_stamped", False)
        ):
            record.msg = f"[request_id={request_id}] {record.msg}"
            record._request_id_stamped = True
        return True
