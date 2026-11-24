import { LOADING_GIRL_POSTER } from "../assets/loadingGirlPoster"

interface LoadingGirlProps {
  label: string
  small?: boolean
}

/**
 * Loading indicator: a small looping animation of a cute anime girl
 * sitting and waiting, with a caption. Shown on first load and again
 * while more sauces generate.
 *
 * The video is a static asset (frontend/public/loading-girl-v1.mp4,
 * served at /loading-girl-v1.mp4) — the browser fetches and caches it
 * independently of the JS bundle, and the poster frame shows instantly
 * while it streams in. (It used to be ~550 KB of base64 inside the JS;
 * bump the -v1 filename if the animation is ever replaced.)
 */
export default function LoadingGirl({ label, small = false }: LoadingGirlProps) {
  return (
    <div className="flex flex-col items-center gap-2" role="status" aria-label={label}>
      <video
        src="/loading-girl-v1.mp4"
        poster={LOADING_GIRL_POSTER}
        autoPlay
        loop
        muted
        playsInline
        aria-hidden
        className={
          small
            ? "w-[21rem] max-w-[80vw] rounded-xl shadow-lg shadow-black/60"
            : "w-[33rem] max-w-[92vw] rounded-2xl shadow-lg shadow-black/60"
        }
      />
      <p className="text-xs text-neutral-400 animate-pulse">{label}</p>
    </div>
  )
}
