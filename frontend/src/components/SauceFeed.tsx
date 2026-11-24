import { useCallback, useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { BATCH_SIZE, fetchNextSauce, fetchSauceBatch } from "../lib/api"
import SauceCard from "./SauceCard"
import LoadingGirl from "./LoadingGirl"

export default function SauceFeed() {
  const [items, setItems] = useState<Sauce[]>([])
  const [blurred, setBlurred] = useState(true) // global toggle, on by default
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false) // top-up in progress
  const loadingRef = useRef(false)
  const seenRef = useRef<Set<number>>(new Set()) // IDs already in the feed
  const sentinelRef = useRef<HTMLDivElement>(null)

  const loadMore = useCallback(async (n = BATCH_SIZE) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadingMore(true)
    try {
      // Never show the same sauce twice in one feed session. If a
      // whole batch comes back already-seen, retry a couple of times
      // instead of silently dead-ending the feed.
      let fresh: Sauce[] = []
      for (let attempt = 0; attempt < 3 && fresh.length === 0; attempt++) {
        const more = n === 1 ? [await fetchNextSauce()] : await fetchSauceBatch(n)
        fresh = more.filter((s) => !seenRef.current.has(s.id))
      }
      fresh.forEach((s) => seenRef.current.add(s.id))
      if (fresh.length) setItems((prev) => [...prev, ...fresh])
      setError(null) // a successful load clears any earlier failure notice
    } catch (e) {
      setError("Could not load sauce. Check your connection and try again.")
    } finally {
      loadingRef.current = false
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { void loadMore(BATCH_SIZE) }, [loadMore])

  // Infinite scroll: when the sentinel (near the end) is visible, top up.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) void loadMore(BATCH_SIZE) },
      { threshold: 0.1 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [loadMore, items.length])

  // Keyboard: ↑/↓ move between cards (the feed container scrolls by snap)
  const feedRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      feedRef.current?.scrollBy({ top: (e.key === "ArrowDown" ? 1 : -1) * window.innerHeight, behavior: "smooth" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!items.length) {
    return (
      <main className="h-[100dvh] bg-black text-white flex flex-col items-center justify-center gap-3">
        {error ? (
          <>
            <p className="text-sm text-neutral-400">{error}</p>
            <button
              type="button"
              onClick={() => { setError(null); void loadMore(BATCH_SIZE) }}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white border border-white/20"
            >
              Tap to retry
            </button>
          </>
        ) : (
          <LoadingGirl label="Loading your first sauce…" />
        )}
        <label className="text-xs text-neutral-500 flex items-center gap-2">
          <input type="checkbox" checked={blurred} onChange={(e) => setBlurred(e.target.checked)} />
          Blur images
        </label>
      </main>
    )
  }

  return (
    <div className="relative bg-black">
      {/* global blur switch, fixed so it survives scrolling */}
      <button
        type="button"
        onClick={() => setBlurred((b) => !b)}
        aria-pressed={!blurred}
        className="fixed left-3 bottom-24 z-20 rounded-full bg-white/10 backdrop-blur px-3 py-2 text-xs text-white border border-white/20"
      >
        {blurred ? "Blur: ON" : "Blur: OFF"}
      </button>

      {/* waiting animation while the next batch is being generated,
          centered on the page */}
      {loadingMore && (
        <div className="fixed inset-0 z-20 flex items-center justify-center pointer-events-none">
          <LoadingGirl small label="Generating more sauce…" />
        </div>
      )}

      {/* top-up failure notice — without this, a failed load mid-feed
          was invisible (the error only rendered on the empty screen) */}
      {error && !loadingMore && (
        <div className="fixed bottom-3 inset-x-0 z-20 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-white/10 backdrop-blur px-4 py-2 border border-white/20">
            <p className="text-xs text-white">{error}</p>
            <button
              type="button"
              onClick={() => { setError(null); void loadMore(BATCH_SIZE) }}
              className="text-xs font-medium text-white underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <main ref={feedRef} className="sauce-feed" aria-label="Random sauce feed">
        {items.map((sauce, i) => (
          <SauceCard
            key={`${sauce.id}-${i}`}
            sauce={sauce}
            blurred={blurred}
            onToggleBlur={() => setBlurred((b) => !b)}
          />
        ))}
        {/* sentinel rendered after the list: the observer fires as the
            last cards come into view, which triggers the next top-up */}
        <div ref={sentinelRef} className="h-px" aria-hidden />
      </main>
    </div>
  )
}
