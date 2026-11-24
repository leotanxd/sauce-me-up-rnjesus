import { useCallback, useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { fetchSaucePages } from "../lib/api"
import { useIntersectionObserver } from "./useIntersectionObserver"

/**
 * The in-sauce paging machine for one card: lazy page-list fetch,
 * arrow-key paging on the active card, and next-page preloading.
 *
 * A card is "active" when it (mostly) fills the viewport — with
 * scroll-snap that's exactly the sauce the user is looking at. The
 * full page list is fetched lazily on first paging and cached here.
 */
export function useGalleryPages(sauce: Sauce) {
  const cardRef = useRef<HTMLElement>(null)
  const { ratio } = useIntersectionObserver(cardRef, { threshold: [0, 0.55, 1] })
  const isActive = ratio >= 0.55

  const [pages, setPages] = useState<string[] | null>(null)
  const [pageIdx, setPageIdx] = useState(0)
  const [loadingPages, setLoadingPages] = useState(false)
  const loadingRef = useRef(false)

  const ensurePages = useCallback(async (): Promise<string[] | null> => {
    if (pages) return pages
    if (loadingRef.current) return null
    loadingRef.current = true
    setLoadingPages(true)
    try {
      const images = await fetchSaucePages(sauce.id)
      const list = images.length ? images : sauce.firstImageUrl ? [sauce.firstImageUrl] : []
      setPages(list)
      return list
    } catch {
      // Do NOT cache a failure (previously this stored a 1-page list
      // and disabled paging for this card forever). Leaving pages null
      // means the next arrow press retries the fetch.
      return null
    } finally {
      loadingRef.current = false
      setLoadingPages(false)
    }
  }, [pages, sauce.id, sauce.firstImageUrl])

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
      if (!list) return // fetch in flight (its caller applies the total) or failed (next press retries)
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
      if (e.key === "ArrowRight") void goToPage(1)
      else if (e.key === "ArrowLeft") void goToPage(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isActive, goToPage])

  // Preload the next page so paging feels instant.
  useEffect(() => {
    if (!pages) return
    const next = pages[pageIdx + 1]
    if (next) {
      const img = new Image()
      img.src = next
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
