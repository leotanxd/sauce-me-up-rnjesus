import type { ButtonHTMLAttributes, ReactNode } from "react"

/** The shared pill styling — one home for what was copy-pasted across
 * SauceFeed and SauceCard. Variants that differ per call site
 * (backdrop blur, padding, text size, font weight, positioning) are
 * passed through className; they never conflict with the base.
 *
 * Hover + focus live here so every pill gets them at once: the ember
 * focus ring (the app's one accent) with a black offset halo so it
 * stays visible over bright artwork. Transitions deliberately do
 * NOT live here — each call site owns exactly one transition utility
 * (two on one element would collide in the stylesheet). */
export const PILL_BASE =
  "rounded-full bg-white/10 text-white border border-white/20 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-black"

/** Filled-accent variant for the app's one primary action (the
 * empty-screen "Tap to retry"). White focus ring: an ember ring on
 * an ember fill would vanish. Composed here, never by appending
 * conflicting utilities through className. */
const PILL_ACCENT =
  "rounded-full bg-ember text-black border border-black/20 hover:bg-ember-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"

/** Large labelled-pill sizing (UX pass): ~58px tall at text-base, so
 * every labelled control clears the 48px thumb minimum. The base
 * stays size-free — call sites compose this plus their own extras
 * (backdrop-blur, font-medium, positioning). */
export const PILL_LG = "px-6 py-4 text-base"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode
  className?: string
  accent?: boolean
}

export default function PillButton({ children, className = "", accent = false, ...rest }: Props) {
  return (
    <button type="button" {...rest} className={`${accent ? PILL_ACCENT : PILL_BASE} ${className}`.trim()}>
      {children}
    </button>
  )
}
