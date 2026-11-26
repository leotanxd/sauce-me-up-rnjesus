import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useImageZoom } from "./useImageZoom"
import { useUiZoom } from "./useUiZoom"
import { UI_ZOOM_STORAGE_KEY } from "../lib/uiZoom"

let hook!: ReturnType<typeof useUiZoom>

function Harness() {
  hook = useUiZoom()
  return (
    <div data-testid="wrap" ref={hook.uiZoomRef}>
      <span data-testid="scale">{hook.uiScale}</span>
    </div>
  )
}

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function wheel(el: HTMLElement, init: WheelEventInit) {
  const evt = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init })
  act(() => {
    el.dispatchEvent(evt)
  })
  return evt
}

const uiWheel = (el: HTMLElement, deltaY: number) =>
  wheel(el, { ctrlKey: true, shiftKey: true, deltaY })

describe("useUiZoom wheel routing", () => {
  it("Ctrl+Shift+wheel up/down moves uiScale the right way, default-prevented", () => {
    render(<Harness />)
    const el = screen.getByTestId("wrap")
    const up = uiWheel(el, -100)
    expect(up.defaultPrevented).toBe(true)
    expect(hook.uiScale).toBeCloseTo(1.16, 2)
    const down = uiWheel(el, 100)
    expect(down.defaultPrevented).toBe(true)
    expect(hook.uiScale).toBeCloseTo(1, 5)
  })

  it("Ctrl-only wheel leaves uiScale unchanged (the image zoom's domain)", () => {
    render(<Harness />)
    const el = screen.getByTestId("wrap")
    wheel(el, { ctrlKey: true, deltaY: -100 })
    expect(hook.uiScale).toBe(1)
  })

  it("plain wheel and Shift-only wheel are untouched and not prevented", () => {
    render(<Harness />)
    const el = screen.getByTestId("wrap")
    const plain = wheel(el, { deltaY: -100 })
    expect(plain.defaultPrevented).toBe(false)
    const shiftOnly = wheel(el, { shiftKey: true, deltaY: -100 })
    expect(shiftOnly.defaultPrevented).toBe(false)
    expect(hook.uiScale).toBe(1)
  })

  it("clamps at 2 and 0.75 under repeated notches", () => {
    render(<Harness />)
    const el = screen.getByTestId("wrap")
    for (let i = 0; i < 30; i++) uiWheel(el, -100)
    expect(hook.uiScale).toBe(2)
    for (let i = 0; i < 60; i++) uiWheel(el, 100)
    expect(hook.uiScale).toBe(0.75)
  })
})

describe("useUiZoom reset", () => {
  it("Ctrl+Shift+0 (matched on e.code) resets to 1; plain 0 and Ctrl+0 do not", () => {
    render(<Harness />)
    const el = screen.getByTestId("wrap")
    uiWheel(el, -100)
    expect(hook.uiScale).toBeGreaterThan(1)

    fireEvent.keyDown(window, { code: "Digit0" })
    expect(hook.uiScale).toBeGreaterThan(1)
    fireEvent.keyDown(window, { code: "Digit0", ctrlKey: true })
    expect(hook.uiScale).toBeGreaterThan(1)

    fireEvent.keyDown(window, { code: "Digit0", ctrlKey: true, shiftKey: true })
    expect(hook.uiScale).toBe(1)
  })
})

describe("useUiZoom persistence", () => {
  it("restores the scale after unmount + remount", () => {
    render(<Harness />)
    const el = screen.getByTestId("wrap")
    uiWheel(el, -100)
    uiWheel(el, -100)
    const expected = hook.uiScale
    expect(expected).toBeGreaterThan(1)

    cleanup()
    render(<Harness />)
    expect(hook.uiScale).toBeCloseTo(expected, 10)
  })

  it("a corrupt stored value falls back to 1", () => {
    window.localStorage.setItem(UI_ZOOM_STORAGE_KEY, "banana")
    render(<Harness />)
    expect(hook.uiScale).toBe(1)
  })

  it("an out-of-range stored value is clamped", () => {
    window.localStorage.setItem(UI_ZOOM_STORAGE_KEY, "99")
    render(<Harness />)
    expect(hook.uiScale).toBe(2)
    cleanup()
    window.localStorage.setItem(UI_ZOOM_STORAGE_KEY, "0.1")
    render(<Harness />)
    expect(hook.uiScale).toBe(0.75)
  })
})

describe("wheel routing integration (image zoom vs UI zoom)", () => {
  let imageHook!: ReturnType<typeof useImageZoom>

  function CombinedHarness() {
    const ui = useUiZoom()
    hook = ui
    const zoom = useImageZoom({ enabled: true })
    imageHook = zoom
    return (
      <div data-testid="wrap" ref={ui.uiZoomRef}>
        <div data-testid="surface" ref={zoom.attachWheel} {...zoom.handlers} />
      </div>
    )
  }

  it("a Ctrl+wheel over the tap layer reaches only the image path", () => {
    render(<CombinedHarness />)
    const surface = screen.getByTestId("surface")
    wheel(surface, { ctrlKey: true, deltaY: -100 })
    expect(imageHook.scale).toBeGreaterThan(1)
    expect(hook.uiScale).toBe(1)
  })

  it("a Ctrl+Shift+wheel over the tap layer reaches only the UI path", () => {
    render(<CombinedHarness />)
    const surface = screen.getByTestId("surface")
    const evt = wheel(surface, { ctrlKey: true, shiftKey: true, deltaY: -100 })
    expect(imageHook.scale).toBe(1)
    expect(hook.uiScale).toBeGreaterThan(1)
    expect(evt.defaultPrevented).toBe(true)
  })
})
