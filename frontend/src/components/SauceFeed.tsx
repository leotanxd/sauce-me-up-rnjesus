import SauceCard from "./SauceCard"
import LoadingGirl from "./LoadingGirl"
import ModeToggle from "./ModeToggle"
import PillButton, { PILL_LG } from "./ui/PillButton"
import { useSauceFeed } from "../hooks/useSauceFeed"

/**
 * The scroll-snap sauce feed. All state and behaviour (loading,
 * dedupe, mode switching, infinite scroll, keyboard nav, dim mode)
 * lives in useSauceFeed; this component is layout only.
 */
export default function SauceFeed() {
  const {
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
  } = useSauceFeed()

  if (!items.length) {
    return (
      <main className="h-[100dvh] bg-black text-white flex flex-col items-center justify-center gap-3">
        <ModeToggle popular={popular} onSwitch={switchMode} />
        {error ? (
          <>
            <p className="text-sm text-neutral-400">{error}</p>
            <PillButton accent onClick={retry} className="px-8 py-4 text-base font-medium transition-colors duration-150">
              Tap to retry
            </PillButton>
          </>
        ) : (
          <LoadingGirl label="Loading your first sauce…" />
        )}
        <label className="text-sm text-neutral-500 flex items-center gap-2 py-3">
          <input
            type="checkbox"
            className="h-6 w-6 accent-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            checked={blurred}
            onChange={(e) => setBlurred(e.target.checked)}
          />
          Blur images
        </label>
      </main>
    )
  }

  // Dim mode: chrome fades out and goes inert (invisible also drops
  // it from the tab order). The Dim toggle itself is the one exit —
  // it stays, at reduced opacity while dimmed.
  const chromeClass = `transition-opacity duration-200 ${
    dimmed ? "opacity-0 invisible pointer-events-none" : "opacity-100 visible"
  }`

  return (
    <div className="relative bg-black">
      <div className={chromeClass}>
        <ModeToggle popular={popular} onSwitch={switchMode} />
      </div>

      {/* Dim toggle in the right-side column; the only control
          that stays visible (at 40% opacity) while dimmed.
          Right-column geometry (all right-4): the card rail spans
          bottom 128–266px, so Dim sits at bottom-[282px] — 16px
          above the rail's top edge. If the rail's contents or its
          bottom-32 offset ever change, recompute this offset. The
          max-height variant compresses the column (rail included)
          on short/landscape viewports. */}
      <PillButton
        onClick={toggleDim}
        aria-pressed={dimmed}
        className={`fixed right-4 bottom-[282px] [@media(max-height:560px)]:bottom-[218px] z-20 backdrop-blur ${PILL_LG} transition-[opacity,background-color,border-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
          dimmed ? "opacity-40 hover:opacity-100 focus-visible:opacity-100" : ""
        }`}
      >
        {dimmed ? "Dim: ON" : "Dim: OFF"}
      </PillButton>

      {/* waiting animation while the next batch is being generated,
          centered on the page */}
      {loadingMore && (
        <div className="fixed inset-0 z-20 flex items-center justify-center pointer-events-none">
          <LoadingGirl small label="Generating more sauce…" />
        </div>
      )}

      {/* top-up failure notice — without this, a failed load mid-feed
          was invisible (the error only rendered on the empty screen).
          Deliberately NOT dimmed away: it is a transient, actionable
          alert, not viewing chrome. */}
      {error && !loadingMore && (
        <div className="fixed bottom-3 inset-x-0 z-20 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-white/10 backdrop-blur px-2 py-1 border border-white/20">
            <p className="text-xs text-white">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="min-h-12 px-5 py-3 text-sm font-medium text-white underline underline-offset-2 rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <main
        ref={feedRef}
        onScroll={onFeedScroll}
        className="sauce-feed"
        aria-label="Random sauce feed"
      >
        {items.map((sauce, i) =>
          // Windowing: only the active card ±2 is mounted. Far cards
          // render as placeholders carrying the .sauce-card class, so
          // height/snap geometry is identical and scrolling is
          // undisturbed; a placeholder has no img, hooks, or network.
          Math.abs(i - activeIndex) > 2 ? (
            <div key={`${sauce.id}-${i}`} className="sauce-card" aria-hidden="true" />
          ) : (
            <SauceCard
              key={`${sauce.id}-${i}`}
              sauce={sauce}
              blurred={blurred}
              onToggleBlur={toggleBlur}
              dimmed={dimmed}
            />
          ),
        )}
        {/* sentinel rendered after the list: the observer fires as the
            last cards come into view, which triggers the next top-up */}
        <div ref={sentinelRef} className="h-px" aria-hidden />
      </main>
    </div>
  )
}
