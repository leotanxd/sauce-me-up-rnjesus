/**
 * True when an arrow-key event should be left to the control that
 * has focus instead of driving feed/page navigation: modifier
 * shortcuts, and any event originating inside an interactive
 * control (button, link, input, …). The one exception is the
 * card's tap layer (.sauce-swipe-layer): it is the artwork surface
 * itself, and arrow keys are its advertised navigation, so focus
 * sitting on it must not engage the guard.
 */
export function shouldIgnoreArrowKeys(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true
  const t = e.target
  if (!(t instanceof Element)) return false
  if (t.closest(".sauce-swipe-layer")) return false
  return t.closest("button, a, input, select, textarea, [contenteditable], [role='button']") !== null
}
