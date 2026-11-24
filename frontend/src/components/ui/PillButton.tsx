import type { ButtonHTMLAttributes, ReactNode } from "react"

/** The shared pill styling — one home for what was copy-pasted across
 * SauceFeed and SauceCard. Variants that differ per call site
 * (backdrop blur, padding, text size, font weight, positioning) are
 * passed through className; they never conflict with the base. */
export const PILL_BASE =
  "rounded-full bg-white/10 text-white border border-white/20"

/** Large labelled-pill sizing (UX pass): ~58px tall at text-base, so
 * every labelled control clears the 48px thumb minimum. The base
 * stays size-free — call sites compose this plus their own extras
 * (backdrop-blur, font-medium, positioning). */
export const PILL_LG = "px-6 py-4 text-base"

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode
  className?: string
}

export default function PillButton({ children, className = "", ...rest }: Props) {
  return (
    <button type="button" {...rest} className={`${PILL_BASE} ${className}`.trim()}>
      {children}
    </button>
  )
}
