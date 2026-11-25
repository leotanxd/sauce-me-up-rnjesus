import { useEffect, useRef, useState } from "react"
import type { Sauce } from "../types"
import { useGalleryPages } from "../hooks/useGalleryPages"
import { useHorizontalSwipe } from "../hooks/useHorizontalSwipe"
import { useIsSmallScreen } from "../hooks/useIsSmallScreen"
import { waitForImage } from "../lib/waitForImage"
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

  // Page-turn animation direction, derived from the pageIdx delta
  // during render (the previous-value pattern — no effect lag).
  // The direction arms the load gate below: when the incoming page
  // is paintable and commits, its wrapper (keyed by shownSrc)
  // remounts carrying the slide class for this direction, so the
  // slide's first frame already has it. onAnimationEnd disarms, so
  // a later src change that isn't a page turn can't replay a stale
  // direction. The animation lives on the wrapper, never the img —
  // the img's own transform belongs to the blur scale.
  const prevPageIdxRef = useRef(pageIdx)
  const pageDirRef = useRef<0 | 1 | -1>(0)
  if (pageIdx !== prevPageIdxRef.current) {
    pageDirRef.current = pageIdx > prevPageIdxRef.current ? 1 : -1
    prevPageIdxRef.current = pageIdx
  }

  // ---- Load-gated page display -----------------------------------
  // `currentSrc` is the page the pager WANTS shown; `shownSrc` is
  // the page actually on screen. A directed turn commits only once
  // the incoming image is loaded + decoded (waitForImage): the old
  // instant swap ran the whole 240 ms slide over an <img> that had
  // not painted yet — on a phone the slide was invisible and the
  // picture popped in after it ended. The outgoing page stays
  // mounted underneath during the slide (underSrc), so the slide
  // always moves a real picture over the old page, never over
  // black. The wait resolves on error / after 3 s too, so a slow or
  // broken image still commits — the old behaviour as a floor.
  const [shownSrc, setShownSrc] = useState(currentSrc)
  const [underSrc, setUnderSrc] = useState<string | null>(null)
  // Direction of the slide currently on screen. State, not the ref
  // above: it must arm exactly at the gated commit render — during
  // the load wait the OLD wrapper must not pick up the class.
  const [animDir, setAnimDir] = useState<0 | 1 | -1>(0)
  const gateTokenRef = useRef(0)
  const underTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(underTimerRef.current), [])

  useEffect(() => {
    if (currentSrc === shownSrc) return
    // No direction (e.g. the page-list load swapping firstImageUrl
    // for pages[0], whose CDN host string can differ): swap at
    // once, ungated and unanimated, exactly as before the gate.
    if (!currentSrc || pageDirRef.current === 0) {
      setShownSrc(currentSrc)
      return
    }
    // Directed turn: hold the current page until the target is
    // paintable. Latest-target-wins — a superseded load that
    // resolves late commits nothing. (shownSrc is read here for
    // the outgoing page but is deliberately not a dependency: the
    // gate re-arms on target changes only.)
    const token = ++gateTokenRef.current
    const outgoing = shownSrc
    const dir = pageDirRef.current
    let cancelled = false
    const commit = () => {
      if (cancelled || token !== gateTokenRef.current) return
      window.clearTimeout(underTimerRef.current)
      setUnderSrc(outgoing)
      setAnimDir(dir)
      setShownSrc(currentSrc)
      // Fallback underlay clear: animationend does not fire when
      // the animation is disabled (prefers-reduced-motion), so the
      // underlay must not depend on it. 400 ms outlasts the longest
      // slide (300 ms on small screens).
      underTimerRef.current = window.setTimeout(() => {
        if (token !== gateTokenRef.current) return
        pageDirRef.current = 0
        setAnimDir(0)
        setUnderSrc(null)
      }, 400)
    }
    // waitForImage resolves on load, error, and timeout alike; the
    // rejection arm is belt-and-braces so a turn can never be
    // trapped by a failed wait.
    void waitForImage(currentSrc).then(commit, commit)
    return () => {
      cancelled = true
    }
  }, [currentSrc])

  const onSlideEnd = () => {
    pageDirRef.current = 0
    setAnimDir(0)
    window.clearTimeout(underTimerRef.current)
    setUnderSrc(null)
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
      {/* Outgoing page, kept mounted underneath during a slide so
          the incoming page slides over a real picture, never over
          black. Purely visual — hidden from assistive tech. */}
      {underSrc && underSrc !== shownSrc ? (
        <div key={`under:${underSrc}`} className="absolute inset-0" aria-hidden={true}>
          <img
            src={underSrc}
            alt=""
            draggable={false}
            className={`sauce-img ${blurred ? "is-blurred" : "is-clear"} absolute inset-0 h-full w-full object-contain select-none`}
          />
        </div>
      ) : null}
      {shownSrc ? (
        <div
          key={shownSrc}
          className={`absolute inset-0 ${
            animDir === 1
              ? "page-anim-next"
              : animDir === -1
                ? "page-anim-prev"
                : ""
          }`}
          onAnimationEnd={onSlideEnd}
        >
          <img
            src={shownSrc}
            alt={blurred ? "" : sauce.title}
            aria-hidden={blurred}
            draggable={false}
            className={`sauce-img ${blurred ? "is-blurred" : "is-clear"} absolute inset-0 h-full w-full object-contain select-none`}
          />
        </div>
      ) : (
        <p className="text-neutral-500 text-sm px-8 text-center">
          No first-page image was returned for this item.
        </p>
      )}

      {/* Page position for screen readers — a direct child of the
          article, NOT inside the header/rail/footer: their dim
          class uses `invisible`, and visibility:hidden can mute a
          live region. Only the active card carries text, so only
          it announces. */}
      <span className="sr-only" role="status">
        {isActive && totalPages !== undefined ? `Page ${pageIdx + 1} of ${totalPages}` : ""}
      </span>

      {/* top bar — gradient backing so the text never sits bare
          over variable artwork (mirrors the caption's) */}
      <header className={`absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] text-sm bg-gradient-to-b from-black/60 to-transparent ${chromeClass}`}>
        <span className="font-semibold tracking-wide">Sauce Me Up, RNJesus</span>
        <span className="text-neutral-400">#{sauce.id}</span>
      </header>

      {/* right rail — source link and page arrows */}
      <div className={`absolute right-4 bottom-32 [@media(max-height:560px)]:bottom-16 z-10 flex flex-col items-center gap-4 ${chromeClass}`}>
        <a
          href={sauce.url}
          target="_blank"
          rel="noreferrer"
          className={`${PILL_BASE} backdrop-blur ${PILL_LG} font-medium transition-colors duration-150`}
        >
          ↗ Source
        </a>
        <div className="flex items-center gap-2">
          <PillButton
            onClick={() => page(-1)}
            disabled={pageIdx === 0}
            aria-label="Previous page"
            className="backdrop-blur flex h-16 w-16 items-center justify-center text-4xl font-medium transition-[transform,background-color,border-color] duration-150 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/10"
          >
            ‹
          </PillButton>
          <PillButton
            onClick={() => page(1)}
            disabled={totalPages !== undefined && pageIdx >= totalPages - 1}
            aria-label="Next page"
            className="backdrop-blur flex h-16 w-16 items-center justify-center text-4xl font-medium transition-[transform,background-color,border-color] duration-150 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/10"
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
            className="mb-2 block max-w-44 max-h-[55dvh] overflow-y-auto rounded-xl border border-white/15 bg-black/85 backdrop-blur p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          >
            <span className="text-base font-medium leading-snug break-words">{sauce.title}</span>
          </button>
        ) : condensable ? (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setTitleExpanded(true)}
            className="block min-h-11 py-2 text-left text-base font-medium leading-snug pr-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
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
        className="sauce-swipe-layer absolute inset-0 z-[5] cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ember"
      />
    </article>
  )
}
