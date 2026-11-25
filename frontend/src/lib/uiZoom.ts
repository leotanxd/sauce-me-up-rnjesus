/**
 * Pure math for the feed-level UI zoom (Ctrl+Shift+wheel — see
 * useUiZoom), mirroring the zoomMath precedent: the CSS `zoom`
 * property does the visual work; this module owns the range and
 * the wheel step so both are unit-testable.
 */

/** Below 0.75 the ≥48px controls fall under ~36px. */
export const UI_ZOOM_MIN = 0.75
/** At 2× the right column already crowds short viewports. */
export const UI_ZOOM_MAX = 2
/** localStorage key — UI scale is a preference, so it persists. */
export const UI_ZOOM_STORAGE_KEY = "sauce-ui-zoom"
/** Per-notch sensitivity: a standard 100-unit notch ≈ ×1.16. */
const UI_ZOOM_WHEEL_FACTOR = 0.0015

export function clampUiScale(s: number): number {
  if (!Number.isFinite(s)) return 1
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, s))
}

/** One wheel step: exponential, so trackpads (many small deltas)
 * accumulate smoothly and notches feel uniform at any scale.
 * Wheel up (deltaY < 0) zooms in. */
export function nextUiScale(scale: number, deltaY: number): number {
  return clampUiScale(scale * Math.exp(-deltaY * UI_ZOOM_WHEEL_FACTOR))
}
