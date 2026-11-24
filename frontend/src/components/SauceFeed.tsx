import SauceCard from "./SauceCard"
import LoadingGirl from "./LoadingGirl"
import ModeToggle from "./ModeToggle"
import PillButton from "./ui/PillButton"
import { useSauceFeed } from "../hooks/useSauceFeed"

/**
 * The scroll-snap sauce feed. All state and behaviour (loading,
 * dedupe, mode switching, infinite scroll, keyboard nav) lives in
 * useSauceFeed; this component is layout only.
 */
export default function SauceFeed() {
  const {
    items,
    blurred,
    setBlurred,
    toggleBlur,
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
            <PillButton onClick={retry} className="px-4 py-2 text-sm">
              Tap to retry
            </PillButton>
          </>
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
      <ModeToggle popular={popular} onSwitch={switchMode} />
      {/* global blur switch, fixed so it survives scrolling */}
      <PillButton
        onClick={toggleBlur}
        aria-pressed={!blurred}
        className="fixed left-3 bottom-24 z-20 backdrop-blur px-3 py-2 text-xs"
      >
        {blurred ? "Blur: ON" : "Blur: OFF"}
      </PillButton>

      {/* waiting animation while the next batch is being generated,
          centered on the page */}
      {loadingMore && (
        <div className="fixed inset-0 z-20 flex items-center justify-center pointer-events-none">
          <LoadingGirl small label="Generating more sauce…" />
        </div>
      )}

      {/* top-up failure notice — without this, a failed load mid-feed
          was invisible (the error only rendered on the empty screen) */}
      {error && !loadingMore && (
        <div className="fixed bottom-3 inset-x-0 z-20 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-white/10 backdrop-blur px-4 py-2 border border-white/20">
            <p className="text-xs text-white">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="text-xs font-medium text-white underline underline-offset-2"
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
