import { useCallback, useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { fetchSaucePages } from "../lib/api"
import { shouldIgnoreArrowKeys } from "../lib/keyboard"
import { useIntersectionObserver } from "./useIntersectionObserver"

/**
 * The in-sauce paging machine for one card: page-list fetch (lazily
 * on first paging, or after a short dwell on the viewed card),
 * arrow-key paging on the active card, and adjacent-page preloading.
 *
 * A card is "active" when it (mostly) fills the viewport — with
 * scroll-snap that's exactly the sauce the user is looking at. The
 * full page list is fetched at most once and cached here.
 */
export function useGalleryPages(sauce: Sauce) {
  const cardRef = useRef<HTMLElement>(null)
  const { ratio } = useIntersectionObserver(cardRef, { threshold: [0, 0.55, 1] })
  const isActive = ratio >= 0.55

  const [pages, setPages] = useState<string[] | null>(null)
  const [pageIdx, setPageIdx] = useState(0)
  const [loadingPages, setLoadingPages] = useState(false)
  // The one in-flight page-list fetch, shared by every caller — a
  // paging press that lands while the dwell prefetch (below) is
  // still fetching awaits the SAME promise and applies its delta
  // when it lands, instead of finding the fetch "busy" and losing
  // the press.
  const fetchRef = useRef<Promise<string[] | null> | null>(null)

  /**
   * Fetch (once) and cache the page list. `silent` is for the dwell
   * prefetch: it must not raise `loadingPages`, or the caption would
   * flicker "Loading pages…" on every card the user merely looks
   * at — that signal stays paging-triggered only. Failures are NOT
   * cached: the next call retries the fetch.
   */
  const ensurePages = useCallback(
    async (options?: { silent?: boolean }): Promise<string[] | null> => {
      if (pages) return pages
      if (!fetchRef.current) {
        fetchRef.current = (async () => {
          try {
            const images = await fetchSaucePages(sauce.id)
            const list = images.length ? images : sauce.firstImageUrl ? [sauce.firstImageUrl] : []
            setPages(list)
            return list
          } catch {
            return null
          } finally {
            fetchRef.current = null
          }
        })()
      }
      if (options?.silent) return fetchRef.current
      setLoadingPages(true)
      try {
        return await fetchRef.current
      } finally {
        setLoadingPages(false)
      }
    },
    [pages, sauce.id, sauce.firstImageUrl],
  )

  // Arrow presses that arrive while the page list is still loading are
  // accumulated here and applied, clamped, once the list exists — so
  // pressing → three times quickly lands three pages ahead, not one.
  const pendingDeltaRef = useRef(0)

  const goToPage = useCallback(
    async (delta: number) => {
      if (pages) {
        if (pages.length < 2) return
        setPageIdx((i) => Math.min(pages.length - 1, Math.max(0, i + delta)))
        return
      }
      pendingDeltaRef.current += delta
      const list = await ensurePages()
      if (!list) return // fetch failed (next press retries); the accumulated delta stays pending for it
      const total = pendingDeltaRef.current
      pendingDeltaRef.current = 0
      if (list.length < 2 || total === 0) return
      setPageIdx((i) => Math.min(list.length - 1, Math.max(0, i + total)))
    },
    [pages, ensurePages],
  )

  // ← previous page, → next page — only on the card being viewed.
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack arrows while a control has focus (the tap
      // layer itself is exempt — arrows are its navigation).
      if (shouldIgnoreArrowKeys(e)) return
      if (e.key === "ArrowRight") void goToPage(1)
      else if (e.key === "ArrowLeft") void goToPage(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isActive, goToPage])

  // Prefetch the page list once the user has actually dwelled on
  // this card (~700 ms active), so the first swipe doesn't have to
  // wait on the fetch — and the preload below gets page 2 loading
  // while page 1 is still on screen. Silent: no "Loading pages…"
  // caption for a card merely looked at. Fast scrolling triggers
  // almost none of these thanks to the dwell. Cost: one upstream
  // detail call per dwelled-on card (a JSON call, not image data);
  // the backend's detail cache absorbs repeats.
  useEffect(() => {
    if (!isActive || pages) return
    const timer = window.setTimeout(() => {
      void ensurePages({ silent: true })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [isActive, pages, ensurePages])

  // Preload the adjacent pages so paging feels instant — the next
  // page (the common direction) and the previous one (back-swipes
  // otherwise rely on cache + re-decode luck). Adjacent-both-ways
  // is the full extent of image preloading: whole galleries are
  // never preloaded (image data is the expensive part on mobile).
  useEffect(() => {
    if (!pages) return
    for (const idx of [pageIdx + 1, pageIdx - 1]) {
      const src = pages[idx]
      if (src) {
        const img = new Image()
        img.src = src
      }
    }
  }, [pages, pageIdx])

  const currentSrc = pages?.[pageIdx] ?? sauce.firstImageUrl
  // Total pages: the fetched list once we have it, otherwise the count
  // the backend verified when it served this sauce — so the caption
  // can always show "Page X of Y", even before any paging happens.
  const totalPages = pages?.length ?? sauce.pageCount ?? undefined

  return {
    cardRef,
    isActive,
    currentSrc,
    pageIdx,
    totalPages,
    goToPage,
    loadingPages,
  }
}
