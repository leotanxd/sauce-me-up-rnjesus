import { useEffect, useState, type RefObject } from "react"

/**
 * Observe one element and report its visibility. The observer
 * lifecycle (create, observe, disconnect) lives here once; callers
 * supply their own thresholds. Options are compared by value so an
 * inline options object doesn't recreate the observer every render.
 * `enabled` lets a caller wait until the element actually exists in
 * the rendered tree (e.g. the feed's sentinel, which only renders
 * once there are items).
 */
export function useIntersectionObserver<T extends Element>(
  ref: RefObject<T | null>,
  options: IntersectionObserverInit,
  enabled = true,
): { isIntersecting: boolean; ratio: number } {
  const [state, setState] = useState({ isIntersecting: false, ratio: 0 })
  const optionsKey = JSON.stringify(options)

  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        setState({
          isIntersecting: entry.isIntersecting,
          ratio: entry.intersectionRatio,
        })
      },
      JSON.parse(optionsKey) as IntersectionObserverInit,
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [ref, optionsKey, enabled])

  return state
}
