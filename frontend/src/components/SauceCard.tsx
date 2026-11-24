import type { Sauce } from "../types"
import { useGalleryPages } from "../hooks/useGalleryPages"
import PillButton, { PILL_BASE, PILL_LG } from "./ui/PillButton"

type Props = {
  sauce: Sauce
  blurred: boolean
  onToggleBlur: () => void
}

/**
 * One full-screen feed card. Shows the sauce's first page; when this
 * card is the one on screen, the user can page through the REST of the
 * gallery with the ← / → arrow keys (or the on-screen ‹ › buttons).
 * All paging state lives in useGalleryPages; this is rendering only.
 */
export default function SauceCard({ sauce, blurred, onToggleBlur }: Props) {
  const { cardRef, currentSrc, pageIdx, totalPages, goToPage, loadingPages } =
    useGalleryPages(sauce)

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
      <div className="absolute right-4 bottom-32 z-10 flex flex-col items-center gap-4">
        <PillButton
          onClick={onToggleBlur}
          aria-pressed={!blurred}
          className={`backdrop-blur ${PILL_LG} font-medium active:scale-95`}
        >
          {blurred ? "👁 Reveal" : "🙈 Blur"}
        </PillButton>
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
            onClick={() => void goToPage(-1)}
            disabled={pageIdx === 0}
            aria-label="Previous page"
            className="backdrop-blur flex h-16 w-16 items-center justify-center text-4xl font-medium active:scale-95 disabled:opacity-40"
          >
            ‹
          </PillButton>
          <PillButton
            onClick={() => void goToPage(1)}
            disabled={totalPages !== undefined && pageIdx >= totalPages - 1}
            aria-label="Next page"
            className="backdrop-blur flex h-16 w-16 items-center justify-center text-4xl font-medium active:scale-95 disabled:opacity-40"
          >
            ›
          </PillButton>
        </div>
      </div>

      {/* caption */}
      <footer className="absolute bottom-0 inset-x-0 z-10 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-base font-medium leading-snug pr-20">{sauce.title}</p>
        <p className="text-xs text-neutral-400 mt-1">
          {loadingPages
            ? "Loading pages…"
            : totalPages !== undefined
              ? `Page ${pageIdx + 1} of ${totalPages} · ← → to browse this sauce`
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
