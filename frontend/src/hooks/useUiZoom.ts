import { useCallback, useEffect, useState } from "react"
import { clampUiScale, nextUiScale, UI_ZOOM_STORAGE_KEY } from "../lib/uiZoom"

/**
 * Feed-level UI zoom: Ctrl+Shift+wheel scales the chrome (buttons,
 * titles, pills) via the CSS `zoom` property on the .ui-zoom
 * groups; the image is untouched. The exact complement of the
 * per-card image zoom — modifier routing keeps the two disjoint
 * (Ctrl = image, Ctrl+Shift = UI).
 *
 * The state lives here in SauceFeed, outside the keyed <main>, so
 * it persists across cards and mode switches. It also persists
 * across reloads via localStorage — a deliberate first for this
 * app: UI scale is an accessibility preference, not per-session
 * view state like blur/dim.
 */
export function useUiZoom() {
  const [uiScale, setUiScale] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(UI_ZOOM_STORAGE_KEY)
      if (raw === null) return 1
      const parsed = Number.parseFloat(raw)
      return Number.isFinite(parsed) ? clampUiScale(parsed) : 1
    } catch {
      return 1 // storage unavailable (private mode, etc.)
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(uiScale))
    } catch {
      // Non-fatal: the scale still applies for this session.
    }
  }, [uiScale])

  const [wrapperEl, setWrapperEl] = useState<HTMLElement | null>(null)
  const uiZoomRef = useCallback((el: HTMLElement | null) => {
    setWrapperEl(el)
  }, [])

  useEffect(() => {
    if (!wrapperEl) return
    // Native + non-passive: React's root wheel handling is passive,
    // and this gesture must be preventDefault()ed — it would
    // otherwise trigger the browser's own Ctrl+wheel page zoom.
    // Wheel events from every descendant (cards, tap layer, rail
    // buttons, the fixed ModeToggle/error bar — fixed elements
    // still bubble through their DOM ancestors) reach this wrapper.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return
      e.preventDefault()
      setUiScale((prev) => nextUiScale(prev, e.deltaY))
    }
    const onKey = (e: KeyboardEvent) => {
      // Match on e.code, not e.key: Shift+0 reports ")" on a US
      // layout and varies by layout; the physical key is stable.
      if (e.code !== "Digit0" || !e.ctrlKey || !e.shiftKey) return
      e.preventDefault()
      setUiScale(1)
    }
    wrapperEl.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("keydown", onKey)
    return () => {
      wrapperEl.removeEventListener("wheel", onWheel)
      window.removeEventListener("keydown", onKey)
    }
  }, [wrapperEl])

  return { uiScale, uiZoomRef }
}
