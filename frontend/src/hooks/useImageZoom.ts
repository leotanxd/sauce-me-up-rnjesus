import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { shouldIgnoreArrowKeys } from "../lib/keyboard"
import {
  clampPan,
  clampScale,
  focalTranslate,
  ZOOM_KEY_STEP,
  ZOOM_PRESET_SCALE,
  ZOOM_WHEEL_FACTOR,
} from "../lib/zoomMath"

type Options = {
  /** All input is inert unless enabled (SauceCard passes isActive,
   * so only the card on screen zooms). */
  enabled: boolean
  /** Fired when a second pointer lands and the gesture becomes a
   * pinch — SauceCard wires this to the swipe hook's
   * cancelGesture(), so a pinch never also pages or taps. */
  onPinchStart?: () => void
}

type ZoomState = { scale: number; tx: number; ty: number }

type Rect = { width: number; height: number; cx: number; cy: number }

type Pinch = {
  startDist: number
  startMid: { x: number; y: number } // relative to centre
  start: ZoomState
}

type Pan = {
  pointerId: number
  startX: number
  startY: number
  startTx: number
  startTy: number
  moved: boolean
}

type TapStart = { pointerId: number; x: number; y: number; time: number }
type Tap = { x: number; y: number; time: number }

/** Tap-candidate slop — the same 10px as the swipe direction lock. */
const TAP_SLOP_PX = 10
/** A tap candidate must complete within this, and a second one
 * must land within this of the first, to count as a double-tap. */
const DOUBLE_TAP_MS = 300
/** …and within this distance of the first tap. */
const DOUBLE_TAP_DIST_PX = 40

const IDENTITY: ZoomState = { scale: 1, tx: 0, ty: 0 }

/**
 * Image-only zoom for one card: pinch, double-tap preset,
 * Ctrl+wheel, +/−/0/Esc keys, and drag-to-pan while zoomed. The
 * transform lands on a dedicated zoom-layer div inside the slide
 * wrapper (never the img — blur owns its transform; never the
 * wrapper — the slide keyframes own its). Chrome never receives
 * it; that isolation is the feature.
 *
 * Gesture arbitration mirrors the swipe hook's settled rules:
 * travel past the slop sets a suppression flag the consumer reads
 * + clears in its click handler, so a gesture's release click
 * never toggles blur; pointercancel itself adds no suppression
 * beyond what the gesture already set.
 */
export function useImageZoom({ enabled, onPinchStart }: Options) {
  const [state, setState] = useState<ZoomState>(IDENTITY)
  // Discrete changes (double-tap, wheel, keys, reset) animate via
  // the zoom layer's is-animating class; live pinch/pan tracking
  // must not transition, so those paths clear the flag.
  const [animating, setAnimating] = useState(false)

  const surfaceElRef = useRef<HTMLElement | null>(null)
  const [surfaceEl, setSurfaceEl] = useState<HTMLElement | null>(null)
  const rectRef = useRef<Rect>({ width: 0, height: 0, cx: 0, cy: 0 })
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<Pinch | null>(null)
  const panRef = useRef<Pan | null>(null)
  const tapStartRef = useRef<TapStart | null>(null)
  const lastTapRef = useRef<Tap | null>(null)
  const suppressClickRef = useRef(false)

  // Latest callback + state for the native listeners (attached in
  // an effect, so they must not close over stale renders).
  const onPinchStartRef = useRef(onPinchStart)
  onPinchStartRef.current = onPinchStart
  const stateRef = useRef(state)
  stateRef.current = state

  const measureRect = useCallback((el: HTMLElement | null): Rect => {
    if (el) {
      const r = el.getBoundingClientRect()
      rectRef.current = {
        width: r.width,
        height: r.height,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      }
    }
    return rectRef.current
  }, [])

  /** Apply a new scale about a focal point (centre-relative px),
   * pan-clamped. Shared by wheel, keys and the double-tap preset. */
  const applyScale = useCallback(
    (nextScale: number, focal: { x: number; y: number }, rect: Rect) => {
      setState((prev) => {
        const s = clampScale(nextScale)
        if (s === 1) return IDENTITY
        const tx = focalTranslate(prev.tx, focal.x, prev.scale, s)
        const ty = focalTranslate(prev.ty, focal.y, prev.scale, s)
        const clamped = clampPan(tx, ty, s, rect.width, rect.height)
        return { scale: s, tx: clamped.tx, ty: clamped.ty }
      })
    },
    [],
  )

  const zoomBy = useCallback(
    (factor: number, focal?: { x: number; y: number }) => {
      setAnimating(true)
      const rect = measureRect(surfaceElRef.current)
      applyScale(stateRef.current.scale * factor, focal ?? { x: 0, y: 0 }, rect)
    },
    [applyScale, measureRect],
  )

  const toggleAt = useCallback(
    (point: { x: number; y: number }) => {
      setAnimating(true)
      const rect = measureRect(surfaceElRef.current)
      const focal = { x: point.x - rect.cx, y: point.y - rect.cy }
      const current = stateRef.current.scale
      if (current > 1) {
        setState(IDENTITY)
      } else {
        applyScale(ZOOM_PRESET_SCALE, focal, rect)
      }
    },
    [applyScale, measureRect],
  )

  const reset = useCallback(() => {
    pointersRef.current.clear()
    pinchRef.current = null
    panRef.current = null
    tapStartRef.current = null
    lastTapRef.current = null
    setAnimating(true)
    setState(IDENTITY)
  }, [])

  /** Read + clear the suppression flag (same contract as the swipe
   * hook's): true means the click now being handled is the tail of
   * a zoom gesture, not a tap. */
  const consumeSuppression = useCallback((): boolean => {
    const suppressed = suppressClickRef.current
    suppressClickRef.current = false
    return suppressed
  }, [])

  // ---- Pointer gestures (pinch / pan / tap candidates) ----------

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!enabled) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    const rect = measureRect(e.currentTarget)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size === 2) {
      // The gesture becomes a pinch. A two-finger touch is never a
      // tap: suppress the release click for the whole pinch, and
      // cancel any one-pointer swipe already in flight.
      suppressClickRef.current = true
      panRef.current = null
      tapStartRef.current = null
      lastTapRef.current = null
      setAnimating(false)
      const [a, b] = [...pointersRef.current.values()]
      pinchRef.current = {
        startDist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        startMid: { x: (a.x + b.x) / 2 - rect.cx, y: (a.y + b.y) / 2 - rect.cy },
        start: stateRef.current,
      }
      onPinchStartRef.current?.()
      return
    }
    if (pointersRef.current.size > 2) return

    // Single pointer: a tap candidate at any zoom level; at scale
    // > 1 it is also a potential pan.
    tapStartRef.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      time: Date.now(),
    }
    if (stateRef.current.scale > 1) {
      panRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTx: stateRef.current.tx,
        startTy: stateRef.current.ty,
        moved: false,
      }
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    const pinch = pinchRef.current
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      const rect = rectRef.current
      const dist = Math.hypot(b.x - a.x, b.y - a.y)
      const mid = { x: (a.x + b.x) / 2 - rect.cx, y: (a.y + b.y) / 2 - rect.cy }
      const s = clampScale(pinch.start.scale * (dist / pinch.startDist))
      if (s === 1) {
        setState(IDENTITY)
        return
      }
      // Keep the image point under the start midpoint under the
      // current midpoint: focal-rescale about the start midpoint,
      // then translate by the midpoint's own travel.
      const fx = focalTranslate(pinch.start.tx, pinch.startMid.x, pinch.start.scale, s)
      const fy = focalTranslate(pinch.start.ty, pinch.startMid.y, pinch.start.scale, s)
      const clamped = clampPan(
        fx + (mid.x - pinch.startMid.x),
        fy + (mid.y - pinch.startMid.y),
        s,
        rect.width,
        rect.height,
      )
      setState({ scale: s, tx: clamped.tx, ty: clamped.ty })
      return
    }

    const pan = panRef.current
    if (pan && e.pointerId === pan.pointerId) {
      const dx = e.clientX - pan.startX
      const dy = e.clientY - pan.startY
      if (Math.max(Math.abs(dx), Math.abs(dy)) > TAP_SLOP_PX) {
        pan.moved = true
        suppressClickRef.current = true
      }
      if (!pan.moved) return
      const rect = rectRef.current
      const clamped = clampPan(
        pan.startTx + dx,
        pan.startTy + dy,
        stateRef.current.scale,
        rect.width,
        rect.height,
      )
      setState((prev) => ({ ...prev, tx: clamped.tx, ty: clamped.ty }))
    }
  }

  const endPointer = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    if (pinchRef.current && pointersRef.current.has(e.pointerId)) {
      // The pinch ends with the current scale kept. The surviving
      // pointer is dead: clear the whole map so it cannot continue
      // as a pan or a swipe, and wait for a fresh pointerdown.
      // Suppression was set at pinch start and stays set — the
      // release click must not toggle blur. (pointercancel adds
      // nothing beyond that, mirroring the swipe hook's rule.)
      pointersRef.current.clear()
      pinchRef.current = null
      panRef.current = null
      tapStartRef.current = null
      return
    }
    pointersRef.current.delete(e.pointerId)

    const pan = panRef.current
    if (pan && e.pointerId === pan.pointerId) panRef.current = null

    const tapStart = tapStartRef.current
    tapStartRef.current = null
    if (cancelled || !tapStart || e.pointerId !== tapStart.pointerId) return
    if (pan?.moved) return
    // A tap candidate: single pointer, within the slop, quick.
    const travel = Math.max(Math.abs(e.clientX - tapStart.x), Math.abs(e.clientY - tapStart.y))
    const now = Date.now()
    if (travel > TAP_SLOP_PX || now - tapStart.time > DOUBLE_TAP_MS) {
      lastTapRef.current = null
      return
    }
    const last = lastTapRef.current
    if (
      last &&
      now - last.time <= DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - last.x, e.clientY - last.y) <= DOUBLE_TAP_DIST_PX
    ) {
      lastTapRef.current = null
      suppressClickRef.current = true
      toggleAt({ x: e.clientX, y: e.clientY })
      return
    }
    lastTapRef.current = { x: e.clientX, y: e.clientY, time: now }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => endPointer(e, false)
  const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => endPointer(e, true)

  // ---- Native listeners: Ctrl+wheel + iOS gesture prevention ---
  // React attaches onWheel as passive at the root, so
  // preventDefault() there is unreliable — these are native,
  // non-passive, and live only while the card is active.
  const attachWheel = useCallback((el: HTMLElement | null) => {
    surfaceElRef.current = el
    setSurfaceEl(el)
  }, [])

  useEffect(() => {
    if (!surfaceEl || !enabled) return
    const onWheel = (e: WheelEvent) => {
      // Modifier routing is disjoint from the UI zoom (§A3):
      // Ctrl+Shift+wheel is the UI handler's, never this one's.
      if (!e.ctrlKey || e.shiftKey) return
      e.preventDefault() // stop the browser's own page zoom
      setAnimating(true)
      const rect = measureRect(surfaceEl)
      const focal = { x: e.clientX - rect.cx, y: e.clientY - rect.cy }
      applyScale(stateRef.current.scale * Math.exp(-e.deltaY * ZOOM_WHEEL_FACTOR), focal, rect)
    }
    const onGesture = (e: Event) => {
      // iOS Safari ignores touch-action for pinch and would scale
      // the page; preventing gesturestart/gesturechange is the
      // mechanism JS pinch libraries rely on. Desktop Safari's
      // trackpad pinch fires these too — prevented the same way
      // (its gesturechange scale value is not consumed in v1).
      e.preventDefault()
    }
    surfaceEl.addEventListener("wheel", onWheel, { passive: false })
    surfaceEl.addEventListener("gesturestart", onGesture, { passive: false })
    surfaceEl.addEventListener("gesturechange", onGesture, { passive: false })
    return () => {
      surfaceEl.removeEventListener("wheel", onWheel)
      surfaceEl.removeEventListener("gesturestart", onGesture)
      surfaceEl.removeEventListener("gesturechange", onGesture)
    }
  }, [surfaceEl, enabled, applyScale, measureRect])

  // ---- Keyboard zoom ---------------------------------------------
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      // Ctrl-held keys belong to browser shortcuts and to the UI
      // zoom's Ctrl+Shift+0 reset (§A3) — never to image zoom.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Same focus guard as the arrow handlers: skip when focus is
      // in a control, tap layer exempt.
      if (shouldIgnoreArrowKeys(e)) return
      if (e.key === "+" || e.key === "=") zoomBy(ZOOM_KEY_STEP)
      else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_KEY_STEP)
      else if (e.key === "0") reset()
      else if (e.key === "Escape" && stateRef.current.scale > 1) reset()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, zoomBy, reset])

  const zoomStyle: CSSProperties = {
    transform: `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`,
  }

  return {
    scale: state.scale,
    isZoomed: state.scale > 1,
    animating,
    zoomStyle,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    attachWheel,
    zoomBy,
    toggleAt,
    reset,
    consumeSuppression,
  }
}
