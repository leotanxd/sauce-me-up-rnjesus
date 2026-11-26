import { describe, expect, it } from "vitest"
import { clampPan, clampScale, focalTranslate } from "./zoomMath"

describe("clampScale", () => {
  it("bounds the scale to [1, 4]", () => {
    expect(clampScale(0.5)).toBe(1)
    expect(clampScale(1)).toBe(1)
    expect(clampScale(2.5)).toBe(2.5)
    expect(clampScale(4)).toBe(4)
    expect(clampScale(9)).toBe(4)
  })

  it("treats non-finite input as unzoomed", () => {
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe("clampPan", () => {
  it("zeroes the translate at scale 1 (scale 1 ⇒ translate 0)", () => {
    expect(clampPan(50, -80, 1, 400, 800)).toEqual({ tx: 0, ty: 0 })
  })

  it("allows exactly (size × (s−1)) / 2 at the boundary, per axis", () => {
    // 400×800 at scale 2: |tx| ≤ 200, |ty| ≤ 400.
    expect(clampPan(200, 400, 2, 400, 800)).toEqual({ tx: 200, ty: 400 })
    expect(clampPan(-200, -400, 2, 400, 800)).toEqual({ tx: -200, ty: -400 })
  })

  it("clamps beyond the boundary, per axis independently", () => {
    expect(clampPan(999, 10, 2, 400, 800)).toEqual({ tx: 200, ty: 10 })
    expect(clampPan(-10, -999, 3, 400, 800)).toEqual({ tx: -10, ty: -800 })
  })

  it("passes an in-bounds translate through untouched", () => {
    expect(clampPan(37, -42, 2.5, 400, 800)).toEqual({ tx: 37, ty: -42 })
  })
})

describe("focalTranslate", () => {
  // The content point under the focal stays under it: with the
  // point at p = (focal − t) / sOld (unscaled coords relative to
  // centre), t′ + p·sNew must equal focal again.
  const pointStaysFixed = (t: number, focal: number, sOld: number, sNew: number) => {
    const p = (focal - t) / sOld
    const tNext = focalTranslate(t, focal, sOld, sNew)
    expect(tNext + p * sNew).toBeCloseTo(focal, 10)
    return tNext
  }

  it("keeps the focal point fixed zooming in", () => {
    pointStaysFixed(0, 120, 1, 2.5)
    pointStaysFixed(30, -80, 1.5, 3)
  })

  it("keeps the focal point fixed zooming out", () => {
    pointStaysFixed(-45, 60, 3, 1.2)
    pointStaysFixed(10, 0, 2.5, 1)
  })

  it("zooming about the centre leaves a centred translate scaled, and 0 at 0", () => {
    expect(focalTranslate(0, 0, 1, 4)).toBe(0)
    expect(focalTranslate(40, 0, 2, 4)).toBe(80)
  })

  it("returns the translate untouched for a zero old scale", () => {
    expect(focalTranslate(25, 100, 0, 2)).toBe(25)
  })
})
