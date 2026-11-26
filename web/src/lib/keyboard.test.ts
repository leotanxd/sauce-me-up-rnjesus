import { afterEach, describe, expect, it } from "vitest"
import { shouldIgnoreArrowKeys } from "./keyboard"

afterEach(() => {
  document.body.innerHTML = ""
})

/** A keydown whose target is `target` (jsdom events report the
 * element they were dispatched on; define it directly here). */
function keyEvent(target: EventTarget | null, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "ArrowRight", ...init })
  Object.defineProperty(e, "target", { value: target })
  return e
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  document.body.appendChild(node)
  return node
}

describe("shouldIgnoreArrowKeys", () => {
  it("ignores events from a button", () => {
    expect(shouldIgnoreArrowKeys(keyEvent(el("button")))).toBe(true)
  })

  it("ignores events from a link", () => {
    expect(shouldIgnoreArrowKeys(keyEvent(el("a")))).toBe(true)
  })

  it("ignores events from an input", () => {
    expect(shouldIgnoreArrowKeys(keyEvent(el("input")))).toBe(true)
  })

  it("ignores events from inside a control (a span within a button)", () => {
    const button = el("button")
    const span = document.createElement("span")
    button.appendChild(span)
    expect(shouldIgnoreArrowKeys(keyEvent(span))).toBe(true)
  })

  it("lets events from the page body drive navigation", () => {
    expect(shouldIgnoreArrowKeys(keyEvent(document.body))).toBe(false)
  })

  it("exempts the tap layer — the artwork surface's arrows are its navigation", () => {
    // The tap layer is itself a <button>; without the exemption the
    // guard would swallow the very keys its caption advertises.
    const layer = el("button", "sauce-swipe-layer")
    expect(shouldIgnoreArrowKeys(keyEvent(layer))).toBe(false)
    const child = document.createElement("span")
    layer.appendChild(child)
    expect(shouldIgnoreArrowKeys(keyEvent(child))).toBe(false)
  })

  it("ignores modifier shortcuts regardless of target", () => {
    expect(shouldIgnoreArrowKeys(keyEvent(document.body, { ctrlKey: true }))).toBe(true)
    expect(shouldIgnoreArrowKeys(keyEvent(document.body, { metaKey: true }))).toBe(true)
    expect(shouldIgnoreArrowKeys(keyEvent(document.body, { altKey: true }))).toBe(true)
  })

  it("lets non-Element targets through (nothing focused to protect)", () => {
    expect(shouldIgnoreArrowKeys(keyEvent(null))).toBe(false)
    expect(shouldIgnoreArrowKeys(keyEvent(document))).toBe(false)
  })
})
