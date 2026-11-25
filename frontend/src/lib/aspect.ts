/**
 * Page-shape classification for the card renderer.
 *
 * Some galleries (webtoon / full-color works) publish each "page"
 * as a stitched vertical strip of many panels: height/width ratios
 * of 4.3–24.2, versus ~1.3–1.9 for a normal manga page. Rendered
 * with object-contain in a one-screen card, a strip shrinks to an
 * unreadable ribbon, so SauceCard detects strips per page image
 * and renders just those width-full in an in-card scroller.
 */
export const STRIP_ASPECT_THRESHOLD = 2.5

/**
 * True when an image is a webtoon-style strip: far taller than any
 * normal manga page (sampled normal pages max out ≈1.9 h/w; strips
 * start ≈4.3). Unknown/zero dimensions are never strips.
 */
export function isStripImage(width: number, height: number): boolean {
  return width > 0 && height > 0 && height / width > STRIP_ASPECT_THRESHOLD
}
