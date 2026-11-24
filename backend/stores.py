"""In-process state stores for the API, each owning its own lock.

RecentServedStore — the bounded no-repeat memory. Thread-safe by
construction: every method takes the lock internally, and the pick
sequence (pick -> verify -> remember) holds the exposed re-entrant
lock across the whole sequence to stay atomic, while the individual
contains/remember calls re-enter it safely.

DetailCache — a bounded, TTL'd cache of parsed gallery details,
with an injectable clock for tests.
"""

import threading
import time
from collections import deque


class RecentServedStore:
    """IDs served recently by this process; bounded, oldest evicted."""

    def __init__(self, maxlen: int = 300):
        self._maxlen = maxlen
        self._ids: deque = deque(maxlen=maxlen)
        self._set: set = set()
        # Re-entrant: the picker holds it across pick->verify->remember
        # while contains()/remember() acquire it again inside.
        self.lock = threading.RLock()

    def __contains__(self, gallery_id: int) -> bool:
        with self.lock:
            return gallery_id in self._set

    def remember(self, gallery_id: int) -> None:
        with self.lock:
            if gallery_id in self._set:
                return
            if len(self._ids) >= self._maxlen:
                self._set.discard(self._ids[0])
            self._ids.append(gallery_id)
            self._set.add(gallery_id)


class DetailCache:
    """gallery_id -> (fetched_at, GalleryDetail), TTL'd and bounded."""

    def __init__(
        self,
        ttl_seconds: float = 300.0,
        max_entries: int = 128,
        clock=time.monotonic,
    ):
        self._ttl = ttl_seconds
        self._max = max_entries
        self._clock = clock
        self._entries: dict = {}
        self._lock = threading.Lock()

    def get(self, gallery_id: int):
        """The cached detail, or None if missing or past its TTL."""
        now = self._clock()
        with self._lock:
            hit = self._entries.get(gallery_id)
            if hit and now - hit[0] < self._ttl:
                return hit[1]
        return None

    def put(self, gallery_id: int, detail) -> None:
        now = self._clock()
        with self._lock:
            if len(self._entries) >= self._max:
                self._entries.clear()
            self._entries[gallery_id] = (now, detail)
