import type { Sauce } from "../types"

type Props = {
  sauce: Sauce
  blurred: boolean
  onToggleBlur: () => void
}

/**
 * One full-screen feed card — the Film Camera template's "one print fills
 * the screen / folds into a phone" idea, stripped to a single item:
 * one image (the first page only), a caption, and the blur toggle.
 */
export default function SauceCard({ sauce, blurred, onToggleBlur }: Props) {
  return (
    <article className="sauce-card relative flex items-center justify-center bg-black overflow-hidden">
      {sauce.firstImageUrl ? (
        <img
          src={sauce.firstImageUrl}
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

      {/* right rail — the blur toggle lives here, TikTok-style */}
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
      </div>

      {/* caption — tapping the image area also toggles on mobile */}
      <footer className="absolute bottom-0 inset-x-0 z-10 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-base font-medium leading-snug pr-20">{sauce.title}</p>
        <p className="text-xs text-neutral-400 mt-1">
          First page only · {blurred ? "Blurred — tap Reveal to show" : "Scroll for the next one"}
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
