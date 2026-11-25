/**
 * Pure math for the per-card image zoom (see useImageZoom). Kept
 * side-effect free, following the lib/keyboard.ts precedent, so the
 * focal/clamp behaviour is proven here directly and the hook tests
 * only have to prove wiring.
 *
 * Coordinates: translates are in px, applied as
 * `translate(tx, ty) scale(s)` with `transform-origin: center`.
 * A focal point is measured relative to the element's centre, in
 * the same px space as the translate.
 */

/** Zoom never goes below fit-to-screen or above 4×. */
export const ZOOM_MIN_SCALE = 1
export const ZOOM_MAX_SCALE = 4
/** Double-tap toggles between fit and this preset. */
export const ZOOM_PRESET_SCALE = 2.5
/** Keyboard +/− step. */
export const ZOOM_KEY_STEP = 1.5
/** Ctrl+wheel sensitivity: scale × exp(-deltaY × this). */
export const ZOOM_WHEEL_FACTOR = 0.002

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return ZOOM_MIN_SCALE
  return Math.min(ZOOM_MAX_SCALE, Math.max(ZOOM_MIN_SCALE, s))
}

/**
 * Clamp a translate so the scaled box, centred, still covers the
 * element: per axis |t| ≤ size × (scale − 1) / 2. At scale 1 the
 * bound is 0, which maintains the invariant scale 1 ⇒ translate 0.
 */
export function clampPan(
  tx: number,
  ty: number,
  scale: number,
  width: number,
  height: number,
): { tx: number; ty: number } {
  const maxTx = Math.max(0, (width * (scale - 1)) / 2)
  const maxTy = Math.max(0, (height * (scale - 1)) / 2)
  // `+ 0` normalises -0 (Math.max(-0, …) can yield it) so callers
  // never render "-0px" or fail strict zero comparisons.
  return {
    tx: Math.min(maxTx, Math.max(-maxTx, tx)) + 0,
    ty: Math.min(maxTy, Math.max(-maxTy, ty)) + 0,
  }
}

/**
 * The translate that keeps the content point under `focal` fixed
 * when the scale changes sOld → sNew (one axis): the point sits at
 * focal = t + p·s, so t′ = focal − (focal − t) × (s′/s).
 */
export function focalTranslate(
  t: number,
  focal: number,
  sOld: number,
  sNew: number,
): number {
  if (sOld === 0) return t
  return focal - (focal - t) * (sNew / sOld)
}
