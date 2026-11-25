import { useRef, type PointerEvent as ReactPointerEvent } from "react"

/** Slop before the gesture locks to its dominant axis (px). */
export const DIRECTION_LOCK_PX = 10
/** Horizontal travel that counts as a deliberate page turn (px) —
 * well above tap wobble, well below a full card width. */
export const SWIPE_THRESHOLD_PX = 56

type Options = {
  /** Handlers are inert unless enabled (SauceCard passes isActive,
   * so only the card on screen pages on swipe). */
  enabled: boolean
  /** Fired once per completed swipe: 1 = next page (swipe left),
   * -1 = previous page (swipe right). */
  onSwipe: (delta: 1 | -1) => void
}

type Gesture = {
  pointerId: number
  startX: number
  startY: number
  axis: "horizontal" | "vertical" | null
}

/**
 * Horizontal swipe detection over Pointer Events (touch + mouse),
 * for the card's tap layer. The layer carries `touch-action: pan-y`
 * (see .sauce-swipe-layer in index.css): the browser keeps vertical
 * scrolling native — a vertical-dominant gesture fires pointercancel
 * or locks vertical here and is abandoned, never half-applied —
 * while horizontal movement streams to this hook.
 *
 * Gesture state lives in refs (no re-renders). Any gesture that
 * travels past the lock slop sets suppressClickRef on release, so
 * the click the browser fires on pointerup doesn't also toggle
 * blur — whether the gesture completed a swipe or was just a drag
 * that went nowhere. The consumer reads + clears the flag in its
 * onClick. A plain tap (within the slop) never sets it, and
 * pointercancel never does (no click follows a browser takeover,
 * and a stale flag would eat the next genuine tap).
 */
export function useHorizontalSwipe({ enabled, onSwipe }: Options) {
  const gestureRef = useRef<Gesture | null>(null)
  const suppressClickRef = useRef(false)

  const releaseCapture = (el: HTMLElement, pointerId: number) => {
    if (typeof el.releasePointerCapture !== "function") return
    try {
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId)
    } catch {
      // Capture may already be gone (pointerup/cancel) — harmless.
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return
    if (e.isPrimary === false) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    const el = e.currentTarget
    // Feature-detected: jsdom and older browsers lack pointer capture.
    if (typeof el.setPointerCapture === "function") {
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // Not fatal — the gesture still tracks moves on the element.
      }
    }
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      axis: null,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    if (g.axis !== null) return // already locked; nothing more to decide
    const dx = Math.abs(e.clientX - g.startX)
    const dy = Math.abs(e.clientY - g.startY)
    if (dx <= DIRECTION_LOCK_PX && dy <= DIRECTION_LOCK_PX) return
    g.axis = dx >= dy ? "horizontal" : "vertical"
    if (g.axis === "vertical") {
      // The feed owns this gesture (vertical scroll) — go inert
      // until the next pointerdown.
      releaseCapture(e.currentTarget, e.pointerId)
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    gestureRef.current = null
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    // Travel past the slop in ANY direction means the release click
    // is the tail of a drag, not a tap — suppress it. This subsumes
    // the completed-swipe case (56px horizontal > 10px slop).
    if (Math.max(Math.abs(dx), Math.abs(dy)) > DIRECTION_LOCK_PX) {
      suppressClickRef.current = true
    }
    if (g.axis !== "horizontal") return
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return // drag, not a page turn
    onSwipe(dx < 0 ? 1 : -1)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    gestureRef.current = null // browser took the gesture over — abort
  }

  /**
   * Abort any in-flight gesture and suppress the click that will
   * follow on release. Used when a second pointer lands and the
   * touch becomes a pinch (the image-zoom hook takes over): a
   * two-finger touch is never a tap, so its release click must not
   * toggle blur or page. Unlike pointercancel — after which no
   * click follows — a pinch's final release DOES fire one, hence
   * setting the flag unconditionally here.
   */
  const cancelGesture = () => {
    gestureRef.current = null
    suppressClickRef.current = true
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    cancelGesture,
    suppressClickRef,
  }
}
