import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useImageZoom } from "./useImageZoom"

let hook!: ReturnType<typeof useImageZoom>

function Harness({
  enabled = true,
  onPinchStart,
}: {
  enabled?: boolean
  onPinchStart?: () => void
}) {
  hook = useImageZoom({ enabled, onPinchStart })
  return <div data-testid="surface" ref={hook.attachWheel} {...hook.handlers} />
}

afterEach(() => {
  cleanup()
})

const RECT = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 400,
  bottom: 800,
  width: 400,
  height: 800,
  toJSON: () => ({}),
} as DOMRect

function renderSurface(onPinchStart?: () => void) {
  render(<Harness onPinchStart={onPinchStart} />)
  const el = screen.getByTestId("surface")
  // jsdom rects are all zeros; the focal/clamp math needs a real
  // box (focal correctness itself is proven against zoomMath).
  el.getBoundingClientRect = () => RECT
  return el
}

const ptr = (id: number) => ({ pointerId: id, pointerType: "touch", isPrimary: id === 1 })

function down(el: HTMLElement, id: number, x: number, y: number) {
  fireEvent.pointerDown(el, { ...ptr(id), clientX: x, clientY: y })
}
function move(el: HTMLElement, id: number, x: number, y: number) {
  fireEvent.pointerMove(el, { ...ptr(id), clientX: x, clientY: y })
}
function up(el: HTMLElement, id: number, x: number, y: number) {
  fireEvent.pointerUp(el, { ...ptr(id), clientX: x, clientY: y })
}
function tap(el: HTMLElement, x = 200, y = 400) {
  down(el, 1, x, y)
  up(el, 1, x, y)
}

function wheel(el: HTMLElement, init: WheelEventInit) {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })
  act(() => {
    el.dispatchEvent(evt)
  })
  return evt
}

describe("useImageZoom pinch", () => {
  it("two-pointer pinch scales up, focal-anchored, and calls the cancel callback at pinch start", () => {
    const onPinchStart = vi.fn()
    const el = renderSurface(onPinchStart)
    down(el, 1, 100, 400)
    down(el, 2, 300, 400) // distance 200, midpoint at centre x=200
    expect(onPinchStart).toHaveBeenCalledTimes(1)
    move(el, 2, 500, 400) // distance 400 → ×2
    expect(hook.scale).toBe(2)
    expect(hook.isZoomed).toBe(true)
    expect(hook.zoomStyle.transform).toContain("scale(2)")
  })

  it("pinch clamps at 4×", () => {
    const el = renderSurface()
    down(el, 1, 100, 400)
    down(el, 2, 300, 400)
    move(el, 2, 1900, 400) // distance 1800 → ×9, clamped
    expect(hook.scale).toBe(4)
  })

  it("pinching back down to ≤ 1 lands exactly on scale 1 / translate 0", () => {
    const el = renderSurface()
    down(el, 1, 100, 400)
    down(el, 2, 300, 400)
    move(el, 2, 500, 400)
    expect(hook.scale).toBe(2)
    up(el, 2, 500, 400)
    up(el, 1, 100, 400)

    down(el, 1, 100, 400)
    down(el, 2, 500, 400) // start distance 400 at scale 2
    move(el, 2, 200, 400) // distance 100 → 2 × 0.25 = 0.5 → clamp 1
    expect(hook.scale).toBe(1)
    expect(hook.zoomStyle.transform).toBe("translate(0px, 0px) scale(1)")
  })

  it("after a pinch ends, the surviving pointer is dead — it neither pans nor re-pinches", () => {
    const el = renderSurface()
    down(el, 1, 100, 400)
    down(el, 2, 300, 400)
    move(el, 2, 500, 400)
    expect(hook.scale).toBe(2)
    // (The pinch itself translated +100px: its midpoint moved
    // right as finger 2 spread. What must not change is anything
    // AFTER the pinch ends.)
    const settled = hook.zoomStyle.transform
    up(el, 2, 500, 400) // pinch ends; pointer 1 still down
    move(el, 1, 300, 600) // survivor drags: must not pan
    expect(hook.zoomStyle.transform).toBe(settled)
    up(el, 1, 300, 600)
  })
})

describe("useImageZoom pan", () => {
  it("a single-pointer drag at scale > 1 pans, clamped to the scaled box", () => {
    const el = renderSurface()
    act(() => hook.zoomBy(2))
    down(el, 1, 200, 400)
    move(el, 1, 260, 430)
    up(el, 1, 260, 430)
    expect(hook.zoomStyle.transform).toContain("translate(60px, 30px)")

    // A second, huge drag clamps at (400 × (2−1)) / 2 = 200.
    down(el, 1, 200, 400)
    move(el, 1, 900, 400)
    up(el, 1, 900, 400)
    expect(hook.zoomStyle.transform).toContain("translate(200px, 30px)")
  })

  it("the same drag at scale 1 changes nothing", () => {
    const el = renderSurface()
    down(el, 1, 200, 400)
    move(el, 1, 300, 500)
    up(el, 1, 300, 500)
    expect(hook.scale).toBe(1)
    expect(hook.zoomStyle.transform).toBe("translate(0px, 0px) scale(1)")
  })
})

describe("useImageZoom double-tap", () => {
  it("two quick taps toggle 1 → 2.5 anchored at the tap point, then back to 1", () => {
    const el = renderSurface()
    tap(el, 300, 400)
    expect(hook.scale).toBe(1) // a single tap does not zoom
    tap(el, 300, 400)
    expect(hook.scale).toBe(2.5)
    // Anchored at x=300 (100px right of the 200 centre):
    // tx = 100 − 100 × 2.5 = −150.
    expect(hook.zoomStyle.transform).toContain("translate(-150px, 0px)")
    tap(el, 300, 400)
    tap(el, 300, 400)
    expect(hook.scale).toBe(1)
    expect(hook.zoomStyle.transform).toBe("translate(0px, 0px) scale(1)")
  })

  it("two taps 400ms apart do not zoom", () => {
    vi.useFakeTimers()
    try {
      const el = renderSurface()
      tap(el)
      act(() => {
        vi.advanceTimersByTime(400)
      })
      tap(el)
      expect(hook.scale).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("two quick taps far apart (> 40px) do not zoom", () => {
    const el = renderSurface()
    tap(el, 100, 400)
    tap(el, 300, 400)
    expect(hook.scale).toBe(1)
  })
})

describe("useImageZoom suppression", () => {
  it("after a pinch, consumeSuppression returns true once, then false", () => {
    const el = renderSurface()
    down(el, 1, 100, 400)
    down(el, 2, 300, 400)
    move(el, 2, 500, 400)
    up(el, 2, 500, 400)
    up(el, 1, 100, 400)
    expect(hook.consumeSuppression()).toBe(true)
    expect(hook.consumeSuppression()).toBe(false)
  })

  it("after a pan past the slop, consumeSuppression returns true once, then false", () => {
    const el = renderSurface()
    act(() => hook.zoomBy(2))
    down(el, 1, 200, 400)
    move(el, 1, 280, 400)
    up(el, 1, 280, 400)
    expect(hook.consumeSuppression()).toBe(true)
    expect(hook.consumeSuppression()).toBe(false)
  })

  it("a plain tap sets no suppression", () => {
    const el = renderSurface()
    tap(el)
    expect(hook.consumeSuppression()).toBe(false)
  })
})

describe("useImageZoom keyboard + reset", () => {
  it("+ / − step by ×1.5, 0 resets, Escape resets when zoomed", () => {
    renderSurface()
    fireEvent.keyDown(window, { key: "+" })
    expect(hook.scale).toBe(1.5)
    fireEvent.keyDown(window, { key: "=" })
    expect(hook.scale).toBe(2.25)
    fireEvent.keyDown(window, { key: "-" })
    expect(hook.scale).toBe(1.5)
    fireEvent.keyDown(window, { key: "0" })
    expect(hook.scale).toBe(1)

    act(() => hook.zoomBy(2))
    expect(hook.scale).toBe(2)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(hook.scale).toBe(1)
  })

  it("reset() returns to scale 1 / translate 0 from a panned zoom", () => {
    const el = renderSurface()
    act(() => hook.zoomBy(2))
    down(el, 1, 200, 400)
    move(el, 1, 260, 430)
    up(el, 1, 260, 430)
    expect(hook.zoomStyle.transform).toContain("translate(60px, 30px)")
    act(() => hook.reset())
    expect(hook.scale).toBe(1)
    expect(hook.zoomStyle.transform).toBe("translate(0px, 0px) scale(1)")
  })

  it("ignores keys with Ctrl held (the UI zoom's Ctrl+Shift+0 must reach only its own handler)", () => {
    renderSurface()
    act(() => hook.zoomBy(2))
    fireEvent.keyDown(window, { key: "0", ctrlKey: true, shiftKey: true })
    expect(hook.scale).toBe(2)
    fireEvent.keyDown(window, { key: "+", ctrlKey: true })
    expect(hook.scale).toBe(2)
  })

  it("is inert when disabled", () => {
    render(<Harness enabled={false} />)
    fireEvent.keyDown(window, { key: "+" })
    expect(hook.scale).toBe(1)
  })
})

describe("useImageZoom wheel", () => {
  it("Ctrl+wheel zooms at the cursor and is default-prevented", () => {
    const el = renderSurface()
    const evt = wheel(el, { ctrlKey: true, deltaY: -100 })
    expect(evt.defaultPrevented).toBe(true)
    expect(hook.scale).toBeCloseTo(Math.exp(0.2), 5)
    const evt2 = wheel(el, { ctrlKey: true, deltaY: 100 })
    expect(evt2.defaultPrevented).toBe(true)
    expect(hook.scale).toBeCloseTo(1, 5)
  })

  it("plain wheel does nothing and is not prevented (it scrolls the feed)", () => {
    const el = renderSurface()
    const evt = wheel(el, { deltaY: -100 })
    expect(evt.defaultPrevented).toBe(false)
    expect(hook.scale).toBe(1)
  })

  it("Ctrl+Shift+wheel is left completely alone (the UI zoom's gesture)", () => {
    const el = renderSurface()
    const evt = wheel(el, { ctrlKey: true, shiftKey: true, deltaY: -100 })
    expect(evt.defaultPrevented).toBe(false)
    expect(hook.scale).toBe(1)
  })
})
