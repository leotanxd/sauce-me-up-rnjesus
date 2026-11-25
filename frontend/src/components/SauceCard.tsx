import { useEffect, useState } from "react"
import type { Sauce } from "../types"
import { useGalleryPages } from "../hooks/useGalleryPages"
import { useHorizontalSwipe } from "../hooks/useHorizontalSwipe"
import { useIsSmallScreen } from "../hooks/useIsSmallScreen"
import PillButton, { PILL_BASE, PILL_LG } from "./ui/PillButton"

type Props = {
  sauce: Sauce
  blurred: boolean
  onToggleBlur: () => void
  /** Dim mode: header, rail and caption fade out and go inert. */
  dimmed: boolean
}

/**
 * One full-screen feed card. Shows the sauce's first page; when this
 * card is the one on screen, the user can page through the REST of
 * the gallery with the ← / → arrow keys, the on-screen ‹ › buttons,
 * or a horizontal swipe on the image. All paging state lives in
 * useGalleryPages; this is rendering plus gesture/title wiring.
 *
 * On small screens a long title condenses to its first 4 words as a
 * button that expands the full title in a narrow panel; on desktop
 * the title is the plain full-text paragraph it has always been.
 */
export default function SauceCard({ sauce, blurred, onToggleBlur, dimmed }: Props) {
  const { cardRef, isActive, currentSrc, pageIdx, totalPages, goToPage, loadingPages } =
    useGalleryPages(sauce)
  const smallScreen = useIsSmallScreen()
  const [titleExpanded, setTitleExpanded] = useState(false)

  // Any page turn collapses an expanded title. Buttons and swipe go
  // through `page` below; keyboard paging happens inside
  // useGalleryPages and bypasses it, so cover it via pageIdx.
  useEffect(() => {
    setTitleExpanded(false)
  }, [pageIdx])
  // Scrolling away collapses too (unmount destroys the state anyway,
  // so a card always comes back collapsed).
  useEffect(() => {
    if (!isActive) setTitleExpanded(false)
  }, [isActive])

  const page = (delta: number) => {
    setTitleExpanded(false)
    void goToPage(delta)
  }

  const swipe = useHorizontalSwipe({
    enabled: isActive,
    onSwipe: (delta) => page(delta),
  })

  // Read + clear the swipe hook's suppression flag; reports whether
  // a drag set it (meaning this click is a drag's tail, not a tap).
  const consumeSuppression = (): boolean => {
    const suppressed = swipe.suppressClickRef.current
    swipe.suppressClickRef.current = false
    return suppressed
  }

  // Tap-layer click order matters: an expanded title consumes the
  // tap as a dismiss; a completed swipe's release-click is swallowed
  // by the suppression flag; anything else is a plain tap → blur.
  const onTapLayerClick = () => {
    if (titleExpanded) {
      setTitleExpanded(false)
      // Consume the flag here too: a drag whose release click
      // dismisses the title must not leave the flag set, or it
      // would swallow the next genuine tap on this card.
      consumeSuppression()
      return
    }
    if (consumeSuppression()) return
    onToggleBlur()
  }

  const chromeClass = `transition-opacity duration-200 ${
    dimmed ? "opacity-0 invisible pointer-events-none" : "opacity-100 visible"
  }`

  // Condensed title (small screens only): more than 4 words → first
  // 4 + " …" as an expand button; ≤ 4 words renders in full, as text.
  const words = sauce.title.trim().split(/\s+/)
  const condensable = smallScreen && words.length > 4
  const condensedTitle = `${words.slice(0, 4).join(" ")} …`

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
      <header className={`absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] text-sm ${chromeClass}`}>
        <span className="font-semibold tracking-wide">Sauce Me Up, RNJesus</span>
        <span className="text-neutral-400">#{sauce.id}</span>
      </header>

      {/* right rail — source link and page arrows */}
      <div className={`absolute right-4 bottom-32 z-10 flex flex-col items-center gap-4 ${chromeClass}`}>
        <a
          href={sauce.url}
          target="_blank"
          rel="noreferrer"
          className={`${PILL_BASE} backdrop-blur ${PILL_LG} font-medium`}
        >
          ↗ Source
        </a>
        <div className="flex items-center gap-2">
          <PillButton
            onClick={() => page(-1)}
            disabled={pageIdx === 0}
            aria-label="Previous page"
            className="backdrop-blur flex h-16 w-16 items-center justify-center text-4xl font-medium active:scale-95 disabled:opacity-40"
          >
            ‹
          </PillButton>
          <PillButton
            onClick={() => page(1)}
            disabled={totalPages !== undefined && pageIdx >= totalPages - 1}
            aria-label="Next page"
            className="backdrop-blur flex h-16 w-16 items-center justify-center text-4xl font-medium active:scale-95 disabled:opacity-40"
          >
            ›
          </PillButton>
        </div>
      </div>

      {/* caption */}
      <footer className={`absolute bottom-0 inset-x-0 z-10 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent ${chromeClass}`}>
        {condensable && titleExpanded ? (
          <button
            type="button"
            aria-expanded={true}
            aria-label="Collapse title"
            onClick={() => setTitleExpanded(false)}
            className="mb-2 block max-w-44 max-h-[55dvh] overflow-y-auto rounded-xl border border-white/15 bg-black/85 backdrop-blur p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <span className="text-base font-medium leading-snug break-words">{sauce.title}</span>
          </button>
        ) : condensable ? (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setTitleExpanded(true)}
            className="block text-left text-base font-medium leading-snug pr-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {condensedTitle}
          </button>
        ) : (
          <p className="text-base font-medium leading-snug pr-20">{sauce.title}</p>
        )}
        <p className="text-xs text-neutral-400 mt-1">
          {loadingPages
            ? "Loading pages…"
            : totalPages !== undefined
              ? `Page ${pageIdx + 1} of ${totalPages} · ← → to browse this sauce`
              : "← → to browse this sauce's pages"}
          {blurred ? " · Blurred — tap the image to show" : ""}
        </p>
      </footer>

      {/* invisible tap-to-toggle layer (below the buttons); also the
          horizontal-swipe surface — pan-y keeps vertical scrolling
          native, horizontal drags page the gallery */}
      <button
        type="button"
        aria-label={blurred ? "Reveal image" : "Blur image"}
        onClick={onTapLayerClick}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        className="sauce-swipe-layer absolute inset-0 z-[5] cursor-default"
      />
    </article>
  )
}
