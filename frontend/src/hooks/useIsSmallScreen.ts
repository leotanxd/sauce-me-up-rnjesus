import { useEffect, useState } from "react"

/** Tailwind's `sm` breakpoint: "small screen" = below 640px. */
const SMALL_SCREEN_QUERY = "(max-width: 639px)"

/**
 * True on small screens (< 640px wide), via matchMedia with a change
 * listener. Initial value is false (desktop) when matchMedia is
 * unavailable (jsdom without the test stub, older browsers), so the
 * desktop render path is the safe default.
 */
export function useIsSmallScreen(): boolean {
  const [small, setSmall] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(SMALL_SCREEN_QUERY).matches
      : false,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const mql = window.matchMedia(SMALL_SCREEN_QUERY)
    const onChange = (e: MediaQueryListEvent) => setSmall(e.matches)
    setSmall(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return small
}
