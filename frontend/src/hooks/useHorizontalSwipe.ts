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
 * Gesture state lives in refs (no re-renders). A completed swipe
 * sets suppressClickRef so the click the browser fires on release
 * doesn't also toggle blur; the consumer reads + clears the flag in
 * its onClick. A plain tap never sets it.
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
    if (g.axis !== "horizontal") return
    const dx = e.clientX - g.startX
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return // tap or wobble
    suppressClickRef.current = true
    onSwipe(dx < 0 ? 1 : -1)
  }

  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    gestureRef.current = null // browser took the gesture over — abort
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    suppressClickRef,
  }
}
