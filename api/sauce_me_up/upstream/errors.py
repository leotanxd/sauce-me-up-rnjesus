"""Shared exception types for the upstream API client."""


class ResourceNotFoundError(RuntimeError):
    """The upstream API returned 404 for the requested resource."""
