import { useCallback, useEffect, useRef, useState } from "react"
import type { FeedMode, Sauce } from "../types"
import { BATCH_SIZE } from "../lib/config"
import { fetchNextSauce, fetchSauceBatch } from "../lib/api"
import { shouldIgnoreArrowKeys } from "../lib/keyboard"
import { loadSeen, saveSeen, type SeenLists } from "../lib/seenSauce"
import { useIntersectionObserver } from "./useIntersectionObserver"

/**
 * The feed state machine: batch loading with per-session dedupe,
 * Random | Popular mode switching, infinite scroll, and ↑/↓ keyboard
 * navigation. SauceFeed.tsx is left as pure layout over this state.
 *
 * The seen set is backed by the persisted per-mode lists in
 * lib/seenSauce (localStorage): a refresh — or a server restart,
 * which wipes the server's own no-repeat window — no longer makes
 * already-served sauces count as new again.
 *
 * Mode switches are guarded by a generation counter: a load that was
 * in flight when the mode changed discards its results instead of
 * mixing the two modes' sauces into one feed.
 */
export function useSauceFeed() {
  const [items, setItems] = useState<Sauce[]>([])
  const [blurred, setBlurred] = useState(true) // global toggle, on by default
  const [dimmed, setDimmed] = useState(false) // dim mode: hide all chrome
  const [popular, setPopular] = useState(false) // feed mode: random vs popular
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false) // top-up in progress
  const [activeIndex, setActiveIndex] = useState(0) // card in the viewport
  const loadingRef = useRef(false)
  const nearEndRef = useRef(false) // proximity trigger's zone state (below)
  // Persisted per-mode seen lists, loaded lazily on first render;
  // seenRef starts as the initial mode's (random's) list, so IDs
  // served in earlier sessions already count as seen.
  const seenListsRef = useRef<SeenLists | null>(null)
  if (seenListsRef.current === null) seenListsRef.current = loadSeen()
  const seenRef = useRef<Set<number>>(new Set(seenListsRef.current.random))
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
      // Never show the same sauce twice. Keep fetching until the
      // batch is filled or the attempt cap is hit, ACCUMULATING the
      // fresh items across attempts: with the persisted seen lists,
      // a batch can legitimately come back mostly-seen (1 fresh of
      // 3), and stopping at the first non-empty batch would grow
      // the feed one card at a time. An item the server re-serves
      // within this same load is accumulated only once (the seen
      // set itself is updated after the loop).
      const fresh: Sauce[] = []
      const freshIds = new Set<number>()
      let sawDuplicates = false
      for (let attempt = 0; attempt < 5 && fresh.length < n; attempt++) {
        const more = n === 1 ? [await fetchNextSauce(mode)] : await fetchSauceBatch(n, mode)
        for (const s of more) {
          if (seenRef.current.has(s.id)) {
            sawDuplicates = true
          } else if (!freshIds.has(s.id)) {
            freshIds.add(s.id)
            fresh.push(s)
          }
        }
      }
      if (genRef.current !== gen) return // mode switched mid-load — discard
      // Append at most n: an over-filled final attempt's extras are
      // NOT marked seen, so they stay eligible for a later batch.
      const appended = fresh.slice(0, n)
      appended.forEach((s) => seenRef.current.add(s.id))
      if (appended.length) {
        // Persist the merged seen set for this mode, so the next
        // session (refresh, tomorrow) starts from it.
        const lists = seenListsRef.current ?? (seenListsRef.current = loadSeen())
        lists[mode] = [...seenRef.current]
        saveSeen(lists)
        setItems((prev) => [...prev, ...appended])
        setError(null) // a successful load clears any earlier failure notice
      } else if (sawDuplicates) {
        // Every attempt came back already-seen: the supply is
        // exhausted for now. Say so — the error bar offers Retry,
        // and retrying re-arms the triggers — instead of leaving
        // the feed silently dead-ended on its last card. (A batch
        // that merely returns empty is not this: nothing was
        // offered, so there is nothing to report.)
        setError("No new sauce right now.")
      }
    } catch {
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
      // Each mode keeps its OWN seen list: stash the outgoing
      // mode's set into its persisted list and load the incoming
      // mode's — so switching back re-applies what that mode has
      // already served, in this and earlier sessions alike.
      const lists = seenListsRef.current ?? (seenListsRef.current = loadSeen())
      lists[popularRef.current ? "popular" : "random"] = [...seenRef.current]
      seenRef.current = new Set(lists[nextPopular ? "popular" : "random"])
      popularRef.current = nextPopular
      setPopular(nextPopular)
      genRef.current += 1 // invalidate any in-flight load
      setItems([])
      setActiveIndex(0)
      setError(null)
      loadingRef.current = false
      feedRef.current?.scrollTo({ top: 0 })
      void loadMore(BATCH_SIZE)
    },
    [loadMore],
  )

  const retry = useCallback(() => {
    setError(null)
    nearEndRef.current = false // re-arm the proximity trigger too
    void loadMore(BATCH_SIZE)
  }, [loadMore])

  // Feed windowing: SauceFeed mounts only the cards within ±2 of the
  // active index (placeholders keep the scroll geometry identical).
  // With mandatory snap and exactly-100dvh cards, scrollTop at rest
  // is a multiple of the card height, so this index is exact — and it
  // updates continuously during scrolling, which is when mounting
  // needs to happen.
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current
    if (!el || el.clientHeight <= 0) return
    const i = Math.round(el.scrollTop / el.clientHeight)
    setActiveIndex((current) => (current === i ? current : i))
  }, [])

  const toggleBlur = useCallback(() => setBlurred((b) => !b), [])

  // Dim mode is feed-global like blur, and like blur it is plain
  // useState — nothing persists across a reload, so reloading is
  // always a way out. Mode switches deliberately leave it alone.
  const toggleDim = useCallback(() => setDimmed((d) => !d), [])

  useEffect(() => { void loadMore(BATCH_SIZE) }, [loadMore])

  // Infinite scroll: when the sentinel (near the end) is visible, top
  // up. The sentinel only exists once the feed view renders, so the
  // observer is enabled only when there are items. The rootMargin
  // pre-fires it a full viewport early — when the second-to-last
  // card is on screen the sentinel is one card below the fold — so
  // scroll-driven top-ups also start a card sooner.
  const { isIntersecting } = useIntersectionObserver(
    sentinelRef,
    { threshold: 0.1, rootMargin: "0px 0px 100% 0px" },
    items.length > 0,
  )
  useEffect(() => {
    if (isIntersecting) void loadMore(BATCH_SIZE)
  }, [isIntersecting, loadMore])

  // Navigation that never reveals the sentinel (keyboard ↓ scrolls
  // exactly one viewport and lands on a snap point, so the sentinel
  // below the last card may never intersect) tops up through this
  // trigger instead: it fires when the active card ENTERS the last
  // two cards — second-to-last or last — a full card earlier than
  // the old last-card-only trigger, so a slow batch is already in
  // flight before the user reaches the end. Entry, not residence,
  // is what fires: moving within the last two does not re-fire (an
  // exhausted top-up must not spin), and scrolling away and back
  // re-arms it. loadMore's in-flight guard dedupes this against
  // the sentinel trigger.
  useEffect(() => {
    const nearEnd = items.length > 0 && activeIndex >= items.length - 2
    const entered = nearEnd && !nearEndRef.current
    nearEndRef.current = nearEnd
    if (entered) void loadMore(BATCH_SIZE)
  }, [activeIndex, items.length, loadMore])

  // Keyboard: ↑/↓ move between cards (the feed container scrolls by snap)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      // Don't hijack arrows while a control has focus (the tap
      // layer itself is exempt — arrows are its navigation).
      if (shouldIgnoreArrowKeys(e)) return
      feedRef.current?.scrollBy({
        top: (e.key === "ArrowDown" ? 1 : -1) * window.innerHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return {
    items,
    blurred,
    setBlurred,
    toggleBlur,
    dimmed,
    toggleDim,
    popular,
    switchMode,
    error,
    loadingMore,
    retry,
    activeIndex,
    onFeedScroll,
    sentinelRef,
    feedRef,
  }
}
