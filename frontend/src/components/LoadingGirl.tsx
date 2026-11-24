import { useEffect, useState } from "react"
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
 * The video itself (~550 KB of base64 in src/assets/loadingGirl.ts) is
 * loaded via dynamic import() so Vite splits it into a separate chunk:
 * the main bundle stays small and paints immediately, the poster frame
 * shows instantly, and the animation swaps in as soon as its chunk
 * arrives.
 */
export default function LoadingGirl({ label, small = false }: LoadingGirlProps) {
  const [src, setSrc] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    import("../assets/loadingGirl")
      .then((m) => { if (!cancelled) setSrc(m.LOADING_GIRL_SRC) })
      .catch(() => { /* poster remains — purely cosmetic */ })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex flex-col items-center gap-2" role="status" aria-label={label}>
      <video
        src={src}
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
