import { useCallback, useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { fetchSaucePages } from "../lib/api"

type Props = {
  sauce: Sauce
  blurred: boolean
  onToggleBlur: () => void
}

/**
 * One full-screen feed card. Shows the sauce's first page; when this
 * card is the one on screen, the user can page through the REST of the
 * gallery with the ← / → arrow keys (or the on-screen ‹ › buttons).
 * The full page list is fetched lazily on first use and cached here.
 */
export default function SauceCard({ sauce, blurred, onToggleBlur }: Props) {
  const cardRef = useRef<HTMLElement>(null)
  const [isActive, setIsActive] = useState(false)
  const [pages, setPages] = useState<string[] | null>(null)
  const [pageIdx, setPageIdx] = useState(0)
  const [loadingPages, setLoadingPages] = useState(false)
  const loadingRef = useRef(false)

  // A card is "active" when it (mostly) fills the viewport — with
  // scroll-snap that's exactly the sauce the user is looking at.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => setIsActive(entries[0].intersectionRatio >= 0.55),
      { threshold: [0, 0.55, 1] },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

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
      // Demo/offline items have no gallery behind them — first page only.
      const list = sauce.firstImageUrl ? [sauce.firstImageUrl] : []
      setPages(list)
      return list
    } finally {
      loadingRef.current = false
      setLoadingPages(false)
    }
  }, [pages, sauce.id, sauce.firstImageUrl])

  const goToPage = useCallback(
    async (delta: number) => {
      const list = pages ?? (await ensurePages())
      if (!list || list.length < 2) return
      setPageIdx((i) => Math.min(list.length - 1, Math.max(0, i + delta)))
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
  const pageCount = pages?.length

  return (
    <article ref={cardRef} className="sauce-card relative flex items-center justify-center bg-black overflow-hidden">
      {currentSrc ? (
        <img
          src={currentSrc}
          alt={blurred ? "" : sauce.title}
          aria-hidden={blurred}
          draggable={false}
          className={`sauce-img ${blurred ? "is-blurred" : "is-clear"} absolute inset-0 h-full w-full object-contain select-none`}
        />
      ) : (
        <p className="text-neutral-500 text-sm px-8 text-center">
          No first-page image was returned for this item.
        </p>
      )}

      {/* top bar */}
      <header className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] text-sm">
        <span className="font-semibold tracking-wide">Sauce Me Up, RNJesus</span>
        <span className="text-neutral-400">#{sauce.id}</span>
      </header>

      {/* right rail — blur toggle, source, and page arrows */}
      <div className="absolute right-3 bottom-28 z-10 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onToggleBlur}
          aria-pressed={!blurred}
          className="rounded-full bg-white/10 backdrop-blur px-3 py-2 text-xs font-medium text-white border border-white/20 active:scale-95"
        >
          {blurred ? "👁 Reveal" : "🙈 Blur"}
        </button>
        <a
          href={sauce.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-white/10 backdrop-blur px-3 py-2 text-xs font-medium text-white border border-white/20"
        >
          ↗ Source
        </a>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void goToPage(-1)}
            disabled={pageIdx === 0}
            aria-label="Previous page"
            className="rounded-full bg-white/10 backdrop-blur px-3 py-2 text-sm font-medium text-white border border-white/20 active:scale-95 disabled:opacity-40"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => void goToPage(1)}
            disabled={pageCount !== undefined && pageIdx >= pageCount - 1}
            aria-label="Next page"
            className="rounded-full bg-white/10 backdrop-blur px-3 py-2 text-sm font-medium text-white border border-white/20 active:scale-95 disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>

      {/* caption */}
      <footer className="absolute bottom-0 inset-x-0 z-10 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-base font-medium leading-snug pr-20">{sauce.title}</p>
        <p className="text-xs text-neutral-400 mt-1">
          {loadingPages
            ? "Loading pages…"
            : pageCount !== undefined
              ? `Page ${pageIdx + 1} of ${pageCount} · ← → to browse this sauce`
              : "← → to browse this sauce's pages"}
          {blurred ? " · Blurred — tap Reveal to show" : ""}
        </p>
      </footer>

      {/* invisible tap-to-toggle layer (below the buttons) */}
      <button
        type="button"
        aria-label={blurred ? "Reveal image" : "Blur image"}
        onClick={onToggleBlur}
        className="absolute inset-0 z-[5] cursor-default"
      />
    </article>
  )
}
