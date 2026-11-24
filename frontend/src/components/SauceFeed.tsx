import { useCallback, useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { BATCH_SIZE, fetchNextSauce, fetchSauceBatch } from "../lib/api"
import SauceCard from "./SauceCard"
import LoadingGirl from "./LoadingGirl"

export default function SauceFeed() {
  const [items, setItems] = useState<Sauce[]>([])
  const [blurred, setBlurred] = useState(true) // global toggle, on by default
  const [popular, setPopular] = useState(false) // feed mode: random vs popular
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false) // top-up in progress
  const loadingRef = useRef(false)
  const seenRef = useRef<Set<number>>(new Set()) // IDs already in the feed
  const sentinelRef = useRef<HTMLDivElement>(null)
  const popularRef = useRef(false)
  const genRef = useRef(0) // bumped on mode switch; stale loads discard

  const loadMore = useCallback(async (n = BATCH_SIZE) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadingMore(true)
    const gen = genRef.current
    const pop = popularRef.current
    try {
      // Never show the same sauce twice in one feed session. If a
      // whole batch comes back already-seen, retry a couple of times
      // instead of silently dead-ending the feed.
      let fresh: Sauce[] = []
      for (let attempt = 0; attempt < 3 && fresh.length === 0; attempt++) {
        const more = n === 1 ? [await fetchNextSauce(pop)] : await fetchSauceBatch(n, pop)
        fresh = more.filter((s) => !seenRef.current.has(s.id))
      }
      if (genRef.current !== gen) return // mode switched mid-load — discard
      fresh.forEach((s) => seenRef.current.add(s.id))
      if (fresh.length) setItems((prev) => [...prev, ...fresh])
      setError(null) // a successful load clears any earlier failure notice
    } catch (e) {
      if (genRef.current === gen) {
        setError("Could not load sauce. Check your connection and try again.")
      }
    } finally {
      if (genRef.current === gen) {
        loadingRef.current = false
        setLoadingMore(false)
      }
    }
  }, [])

  // Switch between the default whole-catalogue random feed and the
  // currently-popular feed: reset the list and start over in the
  // new mode.
  const switchMode = useCallback(
    (nextPopular: boolean) => {
      if (nextPopular === popularRef.current) return
      popularRef.current = nextPopular
      setPopular(nextPopular)
      genRef.current += 1 // invalidate any in-flight load
      seenRef.current.clear()
      setItems([])
      setError(null)
      loadingRef.current = false
      feedRef.current?.scrollTo({ top: 0 })
      void loadMore(BATCH_SIZE)
    },
    [loadMore],
  )

  useEffect(() => { void loadMore(BATCH_SIZE) }, [loadMore])

  // Feed-mode toggle (Random = whole catalogue, Popular = currently
  // popular), fixed at the top centre in both the loading and feed views.
  const modeToggle = (
    <div
      className="fixed top-3 left-1/2 -translate-x-1/2 z-30 flex rounded-full bg-white/10 backdrop-blur border border-white/20 overflow-hidden"
      role="group"
      aria-label="Feed mode"
    >
      <button
        type="button"
        onClick={() => switchMode(false)}
        aria-pressed={!popular}
        className={`px-4 py-2 text-xs font-medium ${popular ? "text-white" : "bg-white text-black"}`}
      >
        Random
      </button>
      <button
        type="button"
        onClick={() => switchMode(true)}
        aria-pressed={popular}
        className={`px-4 py-2 text-xs font-medium ${popular ? "bg-white text-black" : "text-white"}`}
      >
        Popular
      </button>
    </div>
  )

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
        {modeToggle}
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
      {modeToggle}
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
