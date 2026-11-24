import SauceCard from "./SauceCard"
import LoadingGirl from "./LoadingGirl"
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
    sentinelRef,
    feedRef,
  } = useSauceFeed()

  // Feed-mode toggle (Random = whole catalogue, Popular = currently
  // popular), fixed at the top centre in both the loading and feed views.
  const modeToggle = (
    <div
      className="fixed top-3 left-1/2 -translate-x-1/2 z-30 flex rounded-full bg-white/10 backdrop-blur border border-white/20 overflow-hidden"
      role="group"
      aria-label="Feed mode"
    >
      <button
        type="button"
        onClick={() => switchMode(false)}
        aria-pressed={!popular}
        className={`px-4 py-2 text-xs font-medium ${popular ? "text-white" : "bg-white text-black"}`}
      >
        Random
      </button>
      <button
        type="button"
        onClick={() => switchMode(true)}
        aria-pressed={popular}
        className={`px-4 py-2 text-xs font-medium ${popular ? "bg-white text-black" : "text-white"}`}
      >
        Popular
      </button>
    </div>
  )

  if (!items.length) {
    return (
      <main className="h-[100dvh] bg-black text-white flex flex-col items-center justify-center gap-3">
        {modeToggle}
        {error ? (
          <>
            <p className="text-sm text-neutral-400">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="rounded-full bg-white/10 px-4 py-2 text-sm text-white border border-white/20"
            >
              Tap to retry
            </button>
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
      {modeToggle}
      {/* global blur switch, fixed so it survives scrolling */}
      <button
        type="button"
        onClick={toggleBlur}
        aria-pressed={!blurred}
        className="fixed left-3 bottom-24 z-20 rounded-full bg-white/10 backdrop-blur px-3 py-2 text-xs text-white border border-white/20"
      >
        {blurred ? "Blur: ON" : "Blur: OFF"}
      </button>

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

      <main ref={feedRef} className="sauce-feed" aria-label="Random sauce feed">
        {items.map((sauce, i) => (
          <SauceCard
            key={`${sauce.id}-${i}`}
            sauce={sauce}
            blurred={blurred}
            onToggleBlur={toggleBlur}
          />
        ))}
        {/* sentinel rendered after the list: the observer fires as the
            last cards come into view, which triggers the next top-up */}
        <div ref={sentinelRef} className="h-px" aria-hidden />
      </main>
    </div>
  )
}
