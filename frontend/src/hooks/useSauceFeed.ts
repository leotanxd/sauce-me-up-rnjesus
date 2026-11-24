import { useCallback, useEffect, useRef, useState } from "react"
import type { FeedMode, Sauce } from "../types"
import { BATCH_SIZE } from "../lib/config"
import { fetchNextSauce, fetchSauceBatch } from "../lib/api"
import { useIntersectionObserver } from "./useIntersectionObserver"

/**
 * The feed state machine: batch loading with per-session dedupe,
 * Random | Popular mode switching, infinite scroll, and ↑/↓ keyboard
 * navigation. SauceFeed.tsx is left as pure layout over this state.
 *
 * Mode switches are guarded by a generation counter: a load that was
 * in flight when the mode changed discards its results instead of
 * mixing the two modes' sauces into one feed.
 */
export function useSauceFeed() {
  const [items, setItems] = useState<Sauce[]>([])
  const [blurred, setBlurred] = useState(true) // global toggle, on by default
  const [popular, setPopular] = useState(false) // feed mode: random vs popular
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false) // top-up in progress
  const loadingRef = useRef(false)
  const seenRef = useRef<Set<number>>(new Set()) // IDs already in the feed
  const sentinelRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const popularRef = useRef(false)
  const genRef = useRef(0) // bumped on mode switch; stale loads discard

  const loadMore = useCallback(async (n = BATCH_SIZE) => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoadingMore(true)
    const gen = genRef.current
    const mode: FeedMode = popularRef.current ? "popular" : "random"
    try {
      // Never show the same sauce twice in one feed session. If a
      // whole batch comes back already-seen, retry a couple of times
      // instead of silently dead-ending the feed.
      let fresh: Sauce[] = []
      for (let attempt = 0; attempt < 3 && fresh.length === 0; attempt++) {
        const more = n === 1 ? [await fetchNextSauce(mode)] : await fetchSauceBatch(n, mode)
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

  const retry = useCallback(() => {
    setError(null)
    void loadMore(BATCH_SIZE)
  }, [loadMore])

  const toggleBlur = useCallback(() => setBlurred((b) => !b), [])

  useEffect(() => { void loadMore(BATCH_SIZE) }, [loadMore])

  // Infinite scroll: when the sentinel (near the end) is visible, top
  // up. The sentinel only exists once the feed view renders, so the
  // observer is enabled only when there are items.
  const { isIntersecting } = useIntersectionObserver(
    sentinelRef,
    { threshold: 0.1 },
    items.length > 0,
  )
  useEffect(() => {
    if (isIntersecting) void loadMore(BATCH_SIZE)
  }, [isIntersecting, loadMore])

  // Keyboard: ↑/↓ move between cards (the feed container scrolls by snap)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      feedRef.current?.scrollBy({ top: (e.key === "ArrowDown" ? 1 : -1) * window.innerHeight, behavior: "smooth" })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return {
    items,
    blurred,
    setBlurred,
    toggleBlur,
    popular,
    switchMode,
    error,
    loadingMore,
    retry,
    sentinelRef,
    feedRef,
  }
}
