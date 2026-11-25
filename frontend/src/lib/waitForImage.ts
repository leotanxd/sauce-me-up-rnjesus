/**
 * Wait until an image at `src` is actually paintable — loaded AND
 * decoded — so a page-turn slide never animates an empty frame.
 *
 * Never rejects and never waits longer than `timeoutMs`: it resolves
 * on load/decode success, on error, or when the cap elapses,
 * whichever comes first. A failed or slow image therefore still
 * commits (the pre-gate behaviour as a floor); the wait only buys
 * smoothness for the common case.
 */
export function waitForImage(src: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, timeoutMs)
    const img = new Image()
    img.onload = done
    img.onerror = done
    img.src = src
    // decode() resolves once the bitmap is ready to paint, which a
    // bare load event does not guarantee on a phone CPU. Where it is
    // unavailable or rejects (older Safari), load alone is the gate.
    if (typeof img.decode === "function") {
      img.decode().then(done, () => {})
    }
    // A cache-hot image may already be complete before any handler
    // could fire; don't wait for the timeout in that case.
    if (img.complete && img.naturalWidth > 0) done()
  })
}
