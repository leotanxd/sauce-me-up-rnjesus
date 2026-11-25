import { describe, expect, it } from "vitest"
import { isStripImage, STRIP_ASPECT_THRESHOLD } from "./aspect"

describe("isStripImage", () => {
  it("classifies by the captured evidence: normal pages are not strips", () => {
    // A tall normal manga page (sampled normal galleries max ≈1.9).
    expect(isStripImage(1280, 1899)).toBe(false)
    // Gallery 491558's normal opening page.
    expect(isStripImage(300, 420)).toBe(false)
    // A landscape page is never a strip.
    expect(isStripImage(750, 400)).toBe(false)
  })

  it("classifies webtoon strips as strips", () => {
    expect(isStripImage(720, 3562)).toBe(true) // ratio ≈4.9
    // Gallery 491558 page 4, measured from the real file.
    expect(isStripImage(720, 16001)).toBe(true) // ratio ≈22.2
  })

  it("is strict at the threshold: exactly 2.5 is not a strip", () => {
    expect(STRIP_ASPECT_THRESHOLD).toBe(2.5)
    expect(isStripImage(1000, 2500)).toBe(false)
    expect(isStripImage(1000, 2501)).toBe(true)
  })

  it("never calls unknown or degenerate dimensions a strip", () => {
    expect(isStripImage(0, 0)).toBe(false)
    expect(isStripImage(0, 5000)).toBe(false)
    expect(isStripImage(720, 0)).toBe(false)
  })
})
