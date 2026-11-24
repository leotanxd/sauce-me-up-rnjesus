import { LOADING_GIRL_SRC } from "../assets/loadingGirl"

interface LoadingGirlProps {
  label: string
  small?: boolean
}

/**
 * Loading indicator: a small looping animation of a cute anime girl
 * sitting and waiting (embedded in src/assets/loadingGirl.ts), with a
 * caption. Shown on first load and again while more sauces generate.
 */
export default function LoadingGirl({ label, small = false }: LoadingGirlProps) {
  return (
    <div className="flex flex-col items-center gap-2" role="status" aria-label={label}>
      <video
        src={LOADING_GIRL_SRC}
        autoPlay
        loop
        muted
        playsInline
        aria-hidden
        className={
          small
            ? "w-28 rounded-xl shadow-lg shadow-black/60"
            : "w-44 rounded-2xl shadow-lg shadow-black/60"
        }
      />
      <p className="text-xs text-neutral-400 animate-pulse">{label}</p>
    </div>
  )
}
