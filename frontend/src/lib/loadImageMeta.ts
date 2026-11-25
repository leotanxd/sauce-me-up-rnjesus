/**
 * Measure an image's natural (intrinsic) size — the dimensions
 * SauceCard needs to tell a normal page from a webtoon strip.
 *
 * Same contract as waitForImage: never rejects and never waits
 * longer than `timeoutMs`. Resolves { width, height } once the
 * image is loaded + decoded, or null on error / timeout — an
 * unknown size is a normal page as far as the caller is concerned.
 * Costs no extra download: the browser serves the measurement
 * from the same fetch that paints the page.
 */
export function loadImageMeta(
  src: string,
  timeoutMs = 3000,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (meta: { width: number; height: number } | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(meta)
    }
    const timer = window.setTimeout(() => done(null), timeoutMs)
    const img = new Image()
    const succeed = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        done({ width: img.naturalWidth, height: img.naturalHeight })
      } else {
        done(null)
      }
    }
    img.onload = succeed
    img.onerror = () => done(null)
    img.src = src
    // decode() settles once the bitmap is ready, which a bare load
    // event does not guarantee; where it is unavailable or rejects
    // (older Safari), load alone carries the measurement.
    if (typeof img.decode === "function") {
      img.decode().then(succeed, () => {})
    }
    // A cache-hot image may already be complete before any handler
    // could fire; read its size immediately in that case.
    if (img.complete && img.naturalWidth > 0) succeed()
  })
}
