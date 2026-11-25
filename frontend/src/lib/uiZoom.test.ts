import { describe, expect, it } from "vitest"
import { clampUiScale, nextUiScale, UI_ZOOM_MAX, UI_ZOOM_MIN } from "./uiZoom"

describe("clampUiScale", () => {
  it("bounds the scale to [0.75, 2]", () => {
    expect(clampUiScale(0.1)).toBe(UI_ZOOM_MIN)
    expect(clampUiScale(0.75)).toBe(0.75)
    expect(clampUiScale(1)).toBe(1)
    expect(clampUiScale(1.4)).toBe(1.4)
    expect(clampUiScale(2)).toBe(2)
    expect(clampUiScale(5)).toBe(UI_ZOOM_MAX)
  })

  it("treats non-finite input as 1", () => {
    expect(clampUiScale(Number.NaN)).toBe(1)
    expect(clampUiScale(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe("nextUiScale", () => {
  it("wheel up (deltaY < 0) increases, wheel down decreases", () => {
    expect(nextUiScale(1, -100)).toBeGreaterThan(1)
    expect(nextUiScale(1, 100)).toBeLessThan(1)
  })

  it("a standard 100-unit notch multiplies by ~1.16", () => {
    expect(nextUiScale(1, -100)).toBeCloseTo(1.16, 2)
    expect(nextUiScale(1, 100)).toBeCloseTo(1 / 1.16, 2)
  })

  it("repeated notches clamp at both ends and never cross them", () => {
    let s = 1
    for (let i = 0; i < 50; i++) s = nextUiScale(s, -100)
    expect(s).toBe(UI_ZOOM_MAX)
    for (let i = 0; i < 100; i++) s = nextUiScale(s, 100)
    expect(s).toBe(UI_ZOOM_MIN)
  })
})
