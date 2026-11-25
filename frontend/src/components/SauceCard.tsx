import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent as ReactSyntheticEvent,
} from "react"
import type { Sauce } from "../types"
import { useGalleryPages } from "../hooks/useGalleryPages"
import { useHorizontalSwipe } from "../hooks/useHorizontalSwipe"
import { useImageZoom } from "../hooks/useImageZoom"
import { isStripImage } from "../lib/aspect"
import { loadImageMeta } from "../lib/loadImageMeta"
import { waitForImage } from "../lib/waitForImage"
import PillButton, { PILL_BASE, PILL_LG } from "./ui/PillButton"

type Props = {
  sauce: Sauce
  blurred: boolean
  onToggleBlur: () => void
  /** Dim mode: header, rail, title/# block and footer fade out and go inert. */
  dimmed: boolean
  /** Toggle dim mode; this card's Dim pill stays available while dimmed. */
  onToggleDim: () => void
}

/**
 * One full-screen feed card. Shows the sauce's first page; when this
 * card is the one on screen, the user can page through the REST of
 * the gallery with the ← / → arrow keys, the on-screen ‹ › buttons,
 * or a horizontal swipe on the image. All paging state lives in
 * useGalleryPages; this is rendering plus gesture/title wiring.
 *
 * A long title condenses to its first 4 words at any screen size,
 * as a button in the right-side column that expands the full title
 * in a narrow panel; a short title is plain text there.
 */
export default function SauceCard({ sauce, blurred, onToggleBlur, dimmed, onToggleDim }: Props) {
  const { cardRef, isActive, currentSrc, pageIdx, totalPages, goToPage, loadingPages } =
    useGalleryPages(sauce)
  const [titleExpanded, setTitleExpanded] = useState(false)

  // Any page turn collapses an expanded title and resets the
  // image zoom. Buttons and swipe go through `page` below;
  // keyboard paging happens inside useGalleryPages and bypasses
  // it, so cover it via pageIdx. (The zoom hook is instantiated
  // further down; these callbacks run after render, so the
  // reference is live by then.)
  useEffect(() => {
    setTitleExpanded(false)
    zoom.reset()
  }, [pageIdx])
  // Scrolling away collapses too (unmount destroys the state anyway,
  // so a card always comes back collapsed) — and a card scrolled
  // away and back is unzoomed.
  useEffect(() => {
    if (!isActive) {
      setTitleExpanded(false)
      zoom.reset()
    }
  }, [isActive])

  const page = (delta: number) => {
    setTitleExpanded(false)
    zoom.reset()
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

  // ---- Image error state ------------------------------------------
  // The load gate resolves on error too (a broken page still
  // commits, as a floor), but the shown <img> itself can fail —
  // CDN hiccup, dead host. Without this the card is a broken image
  // over black with no explanation and no way out. The panel is an
  // actionable alert, so it renders outside the dimmed chrome (the
  // feed-level error bar sets the same precedent).
  const [imgError, setImgError] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  // A page change is a fresh image: any error state belongs to the
  // page that raised it.
  useEffect(() => {
    setImgError(false)
  }, [shownSrc])

  const retryImage = () => {
    setImgError(false)
    // A fresh attempt starts unzoomed too.
    zoom.reset()
    // No slide on retry: clear any armed direction/underlay first,
    // then remount the img via the nonce in its wrapper key — a
    // fresh element re-requests an errored resource. If it fails
    // again, onError re-raises the panel.
    onSlideEnd()
    setRetryNonce((n) => n + 1)
  }

  // ---- Strip (webtoon) page detection ----------------------------
  // Some galleries publish each page as a stitched vertical strip
  // (height many times the width); fit-to-screen rendering shrinks
  // a whole strip into an unreadable ribbon. The shown page's
  // natural size is measured (loadImageMeta, plus the img's own
  // load event as a backstop) and strip pages render width-full in
  // an in-card scroller instead — see the render branch below.
  // Classification is per shown page: mixed galleries flip modes
  // as the user pages. The meta is reset DURING RENDER when the
  // src changes (the previous-value pattern, like pageDirRef
  // above) so a stale aspect never classifies the next page, not
  // even for one frame.
  const [shownMeta, setShownMeta] = useState<{ width: number; height: number } | null>(null)
  const [metaSrc, setMetaSrc] = useState(shownSrc)
  if (metaSrc !== shownSrc) {
    setMetaSrc(shownSrc)
    setShownMeta(null)
  }

  useEffect(() => {
    if (!shownSrc) return
    let cancelled = false
    void loadImageMeta(shownSrc).then((meta) => {
      if (!cancelled) setShownMeta(meta)
    })
    return () => {
      cancelled = true
    }
  }, [shownSrc])

  // Backstop: the shown <img> itself reports its natural size on
  // load. Covers the Retry remount (same src, fresh element),
  // where the effect above does not re-run.
  const onShownImgLoad = (e: ReactSyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setShownMeta({ width: img.naturalWidth, height: img.naturalHeight })
    }
  }

  const stripMode = shownMeta !== null && isStripImage(shownMeta.width, shownMeta.height)

  // ---- Image zoom --------------------------------------------------
  // Per-card zoom of the artwork only (pinch / double-tap /
  // Ctrl+wheel / +−0Esc keys; drag pans while zoomed). The transform
  // lands on a dedicated layer inside the slide wrapper — never the
  // img (blur owns its transform), never the wrapper (the slide
  // keyframes own its), and never any chrome. The zoom hook is
  // created before the swipe hook because the swipe's enabled flag
  // depends on the zoom state; the pinch → cancel-swipe wire
  // therefore goes through a ref.
  const swipeCancelRef = useRef<() => void>(() => {})
  const zoom = useImageZoom({
    enabled: isActive,
    onPinchStart: () => swipeCancelRef.current(),
  })

  const swipe = useHorizontalSwipe({
    // Inert while zoomed: a drag then pans the image (the zoom
    // hook owns the pointer stream) instead of paging.
    enabled: isActive && !zoom.isZoomed,
    onSwipe: (delta) => page(delta),
  })
  swipeCancelRef.current = swipe.cancelGesture

  // Pointer handlers compose zoom-first, then swipe: on a second
  // pointer the zoom hook starts the pinch and cancels the swipe
  // gesture before the swipe hook can act on that pointer.
  const onSurfacePointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    zoom.handlers.onPointerDown(e)
    swipe.onPointerDown(e)
  }
  const onSurfacePointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    zoom.handlers.onPointerMove(e)
    swipe.onPointerMove(e)
  }
  const onSurfacePointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    zoom.handlers.onPointerUp(e)
    swipe.onPointerUp(e)
  }
  const onSurfacePointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    zoom.handlers.onPointerCancel(e)
    swipe.onPointerCancel(e)
  }

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
  // Whichever branch runs, BOTH suppression flags (swipe and zoom)
  // are read + cleared, so neither can leak into the next genuine
  // tap on this card.
  const onTapLayerClick = () => {
    if (titleExpanded) {
      setTitleExpanded(false)
      // Consume the flags here too: a drag whose release click
      // dismisses the title must not leave a flag set, or it
      // would swallow the next genuine tap on this card.
      consumeSuppression()
      zoom.consumeSuppression()
      return
    }
    if (consumeSuppression()) {
      zoom.consumeSuppression()
      return
    }
    if (zoom.consumeSuppression()) return
    onToggleBlur()
  }

  // Strip mode's gesture surface is a div (a <button> cannot wrap
  // a scrolling region), so Enter/Space activation is wired by
  // hand to the same tap semantics as the button it replaces.
  // preventDefault keeps Space from scrolling the strip instead
  // of "clicking" it.
  const onStripKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    onTapLayerClick()
  }

  const chromeClass = `transition-opacity duration-200 ${
    dimmed ? "opacity-0 invisible pointer-events-none" : "opacity-100 visible"
  }`

  // Condensed title (all widths): more than 4 words → first 4 +
  // " …" as an expand button; ≤ 4 words renders in full, as text.
  const words = sauce.title.trim().split(/\s+/)
  const condensable = words.length > 4
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
          key={`${shownSrc}:${retryNonce}`}
          className={`absolute inset-0 ${
            animDir === 1
              ? "page-anim-next"
              : animDir === -1
                ? "page-anim-prev"
                : ""
          }${stripMode ? " z-[6]" : ""}`}
          onAnimationEnd={onSlideEnd}
        >
          {stripMode ? (
            /* Strip page: width-full inside an in-card vertical
               scroller (keyed by src, so each strip starts at its
               top), presented at readable width like the source
               site's reader instead of fit-to-screen. The scroller
               IS the gesture surface here — it carries the tap
               layer's class, pointer handlers and click semantics,
               and sits above the (unrendered) tap-layer button's
               z-[5] via the wrapper's z-[6]. A <button> cannot wrap
               a scrolling region, so it is a div with role="button"
               and hand-wired Enter/Space activation. Scroll
               chaining stays at the default: a pan that runs past
               the strip's end chains into the feed and moves one
               card, so the feed stays navigable. */
            <div
              key={shownSrc}
              role="button"
              tabIndex={0}
              aria-label={blurred ? "Reveal image" : "Blur image"}
              onClick={onTapLayerClick}
              onKeyDown={onStripKeyDown}
              onPointerDown={swipe.onPointerDown}
              onPointerMove={swipe.onPointerMove}
              onPointerUp={swipe.onPointerUp}
              onPointerCancel={swipe.onPointerCancel}
              className="strip-scroll sauce-swipe-layer absolute inset-0 overflow-y-auto cursor-default focus-visible:outline-none"
            >
              <img
                src={shownSrc}
                alt={blurred ? "" : sauce.title}
                aria-hidden={blurred}
                draggable={false}
                onLoad={onShownImgLoad}
                onError={() => setImgError(true)}
                className={`sauce-img ${blurred ? "is-blurred" : "is-clear"} block h-auto w-full select-none`}
              />
            </div>
          ) : (
            /* Normal page: the img rides inside the zoom layer —
               the one element the image zoom transform may touch.
               It sits between the slide wrapper (whose keyframes
               own its transform) and the img (whose transform is
               the blur scale), so slide, blur and zoom compose
               without ever sharing an element. */
            <div
              className={`sauce-zoom-layer absolute inset-0${zoom.animating ? " is-animating" : ""}`}
              style={zoom.zoomStyle}
            >
              <img
                src={shownSrc}
                alt={blurred ? "" : sauce.title}
                aria-hidden={blurred}
                draggable={false}
                onLoad={onShownImgLoad}
                onError={() => setImgError(true)}
                className={`sauce-img ${blurred ? "is-blurred" : "is-clear"} absolute inset-0 h-full w-full object-contain select-none`}
              />
            </div>
          )}
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

      {/* Image-failure panel: centred, above the artwork but below
          the chrome. The wrapper ignores pointer events so the tap
          layer and paging stay usable around the panel; only the
          panel itself captures clicks. Not dimmed (see above). */}
      {imgError && shownSrc ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <div className="ui-zoom pointer-events-auto flex flex-col items-center gap-3 rounded-2xl border border-white/15 bg-black/85 backdrop-blur px-6 py-5">
            <p className="text-sm text-white">This page didn't load.</p>
            <PillButton onClick={retryImage} aria-label="Retry loading this page" className="px-5 py-3 text-sm font-medium">
              Retry
            </PillButton>
          </div>
        </div>
      ) : null}

      {/* top bar — gradient backing so the text never sits bare
          over variable artwork (mirrors the caption's). Brand
          only: the sauce #number lives in the right column now. */}
      <header className={`ui-zoom absolute top-0 inset-x-0 z-10 flex items-center px-4 pt-[max(1rem,env(safe-area-inset-top))] text-sm bg-gradient-to-b from-black/60 to-transparent ${chromeClass}`}>
        <span className="font-semibold tracking-wide">Sauce Me Up, RNJesus</span>
      </header>

      {/* Right column — ONE bottom-anchored stack at the safe-area
          corner: rail at the corner, Dim 16px above it, the title
          above Dim, the sauce #number on top (DOM order below is
          top-down: #/title block, Dim, rail). A single flex column
          rather than per-element offsets, so the safe-area bottom
          inset (~34px on a notched phone) is applied once at the
          anchor and the stack can never tear. Everything rides
          112px lower than the old floated layout (the rail was at
          bottom-32); under max-height:560px the stack instead
          SHRINKS by the same 64px the old layout shifted — gaps
          16→8, arrows 64→48, labelled pills py-4→py-3. The
          container is never dim-hidden (it holds the Dim exit):
          the rail and the title/# block carry the chrome class,
          and because `invisible` keeps their layout space, Dim
          does not move a pixel when dim toggles. z-20 keeps the
          column above the strip scroller (z-[6]) and the tap
          layer (z-[5]). */}
      <div className="ui-zoom absolute right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 flex flex-col items-end gap-4 [@media(max-height:560px)]:gap-2">
        {/* #number + title block (chrome). The expanded title
            panel grows upward in-flow from here — its max-height
            caps keep its top below the ModeToggle: the panel's
            bottom edge sits 244px above the card bottom (188px
            compressed), and the caps reserve a further 84px. */}
        <div className={`flex w-44 flex-col items-end gap-4 [@media(max-height:560px)]:gap-2 ${chromeClass}`}>
          <span className="text-sm text-neutral-400 [text-shadow:_0_1px_3px_rgb(0_0_0_/_0.9)]">#{sauce.id}</span>
          {condensable && titleExpanded ? (
            <button
              type="button"
              aria-expanded={true}
              aria-label="Collapse title"
              onClick={() => setTitleExpanded(false)}
              className="block w-full max-h-[calc(100dvh-328px)] [@media(max-height:560px)]:max-h-[calc(100dvh-272px)] overflow-y-auto rounded-xl border border-white/15 bg-black/85 backdrop-blur p-3 text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              <span className="text-base font-medium leading-snug break-words">{sauce.title}</span>
            </button>
          ) : condensable ? (
            <button
              type="button"
              aria-expanded={false}
              onClick={() => setTitleExpanded(true)}
              className="block w-full rounded-xl border border-white/15 bg-black/85 backdrop-blur p-3 text-right text-base font-medium leading-snug break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
            >
              {condensedTitle}
            </button>
          ) : (
            <p className="text-base font-medium leading-snug text-right break-words [text-shadow:_0_1px_3px_rgb(0_0_0_/_0.9)]">{sauce.title}</p>
          )}
        </div>

        {/* Dim toggle — never chrome-hidden: it is the only exit
            from dim mode, so while dimmed it stays clickable at
            40% opacity (restored on hover/focus). */}
        <PillButton
          onClick={onToggleDim}
          aria-pressed={dimmed}
          className={`backdrop-blur ${PILL_LG} [@media(max-height:560px)]:py-3 transition-[opacity,background-color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
            dimmed ? "opacity-40 hover:opacity-100 focus-visible:opacity-100" : ""
          }`}
        >
          {dimmed ? "Dim: ON" : "Dim: OFF"}
        </PillButton>

        {/* rail — source link and page arrows, at the corner */}
        <div className={`flex flex-col items-center gap-4 [@media(max-height:560px)]:gap-2 ${chromeClass}`}>
          <a
            href={sauce.url}
            target="_blank"
            rel="noreferrer"
            className={`${PILL_BASE} backdrop-blur ${PILL_LG} [@media(max-height:560px)]:py-3 font-medium transition-colors duration-150`}
          >
            ↗ Source
          </a>
          <div className="flex items-center gap-2">
            <PillButton
              onClick={() => page(-1)}
              disabled={pageIdx === 0}
              aria-label="Previous page"
              className="backdrop-blur flex h-16 w-16 [@media(max-height:560px)]:h-12 [@media(max-height:560px)]:w-12 items-center justify-center text-4xl font-medium transition-[transform,background-color,border-color] duration-150 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/10"
            >
              ‹
            </PillButton>
            <PillButton
              onClick={() => page(1)}
              disabled={totalPages !== undefined && pageIdx >= totalPages - 1}
              aria-label="Next page"
              className="backdrop-blur flex h-16 w-16 [@media(max-height:560px)]:h-12 [@media(max-height:560px)]:w-12 items-center justify-center text-4xl font-medium transition-[transform,background-color,border-color] duration-150 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/10"
            >
              ›
            </PillButton>
          </div>
        </div>
      </div>

      {/* caption — the Page X of Y line only; the title lives in
          the right column now. pr-40 reserves the corner rail's
          footprint (16px offset + 136px arrows row = 152px) so
          the line never runs under the arrows on narrow screens. */}
      <footer className={`ui-zoom absolute bottom-0 inset-x-0 z-10 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent ${chromeClass}`}>
        <p className="text-xs text-neutral-400 pr-40">
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
          native, horizontal drags page the gallery. Deliberately NO
          focus ring on this layer: it covers the whole card, so a
          focus-visible ring would frame the entire viewport (Leo
          reported exactly that as a bug after clicking to unblur and
          then pressing Space/Enter). It stays a real focusable
          button — keyboard activation still toggles blur — it just
          carries no visible ring. Don't re-add one. In strip mode
          this button is not rendered at all: the strip scroller
          above takes over its role (it would otherwise re-capture
          the vertical pans the strip needs). */}
      {!stripMode ? (
        <button
          type="button"
          ref={zoom.attachWheel}
          aria-label={blurred ? "Reveal image" : "Blur image"}
          onClick={onTapLayerClick}
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          onPointerCancel={onSurfacePointerCancel}
          // While zoomed, drags must stream to the zoom hook's pan
          // instead of becoming native feed scroll: touch-action
          // none overrides the .sauce-swipe-layer pan-y rule. At
          // scale 1 the inline style is absent and pan-y behaviour
          // is exactly as before. (The ref above also anchors the
          // zoom hook's native Ctrl+wheel / iOS-gesture listeners.)
          style={{ touchAction: zoom.isZoomed ? "none" : undefined }}
          className="sauce-swipe-layer absolute inset-0 z-[5] cursor-default focus-visible:outline-none"
        />
      ) : null}
    </article>
  )
}
