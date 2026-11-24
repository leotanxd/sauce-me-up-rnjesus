import { useCallback, useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { fetchNextSauce, fetchSauceBatch } from "../lib/api"
import SauceCard from "./SauceCard"
import LoadingGirl from "./LoadingGirl"

const PREFETCH_AT = 2 // fetch more when this many cards remain below
const BATCH_SIZE = 3 // sauces generated per load / top-up

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
      const more = n === 1 ? [await fetchNextSauce()] : await fetchSauceBatch(n)
      // Never show the same sauce twice in one feed session.
      const fresh = more.filter((s) => !seenRef.current.has(s.id))
      fresh.forEach((s) => seenRef.current.add(s.id))
      setItems((prev) => [...prev, ...fresh])
    } catch (e) {
      setError("Could not load more. Scroll back and try again.")
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
          <p className="text-sm text-neutral-400">{error}</p>
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

      <main ref={feedRef} className="sauce-feed" aria-label="Random sauce feed">
        {items.map((sauce, i) => (
          <SauceCard
            key={`${sauce.id}-${i}`}
            sauce={sauce}
            blurred={blurred}
            onToggleBlur={() => setBlurred((b) => !b)}
          />
        ))}
        {/* sentinel sits PREFETCH_AT cards before the end in effect:
            it's rendered after the list, IO fires as the last cards show */}
        <div ref={sentinelRef} className="h-px" aria-hidden />
      </main>
    </div>
  )
}
