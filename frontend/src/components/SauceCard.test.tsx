import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"
import { IntersectionObserverStub, setSmallScreen } from "../test/setup"

vi.mock("../lib/api", () => ({
  fetchNextSauce: vi.fn(),
  fetchSauceBatch: vi.fn(),
  fetchSaucePages: vi.fn(),
}))

import SauceCard from "./SauceCard"

const longTitle: Sauce = {
  id: 7,
  title: "One two three four five six seven eight nine",
  url: "https://nhentai.net/g/7/",
  firstImageUrl: "https://img.example/7.jpg",
  pageCount: 12,
}

const shortTitle: Sauce = { ...longTitle, id: 8, title: "Short little title" }

function renderCard(sauce: Sauce, dimmed = false) {
  return render(
    <SauceCard sauce={sauce} blurred={true} onToggleBlur={() => {}} dimmed={dimmed} />,
  )
}

afterEach(() => {
  cleanup()
  setSmallScreen(false)
})

describe("SauceCard titles on small screens", () => {
  it("condenses a >4-word title to 4 words + … and expands on tap", () => {
    setSmallScreen(true)
    renderCard(longTitle)

    const toggle = screen.getByRole("button", { name: "One two three four …" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText(longTitle.title)).toBeNull()

    fireEvent.click(toggle)
    const panel = screen.getByRole("button", { name: "Collapse title" })
    expect(panel.getAttribute("aria-expanded")).toBe("true")
    expect(panel.className).toContain("max-w-44")
    expect(screen.getByText(longTitle.title)).not.toBeNull()

    fireEvent.click(panel)
    expect(screen.getByRole("button", { name: "One two three four …" })).not.toBeNull()
    expect(screen.queryByText(longTitle.title)).toBeNull()
  })

  it("renders a ≤4-word title in full with no expand button", () => {
    setSmallScreen(true)
    const { container } = renderCard(shortTitle)
    expect(screen.getByText("Short little title")).not.toBeNull()
    expect(container.querySelector("[aria-expanded]")).toBeNull()
  })
})

describe("SauceCard titles on desktop", () => {
  it("renders the full title as plain text with no expand button", () => {
    setSmallScreen(false)
    const { container } = renderCard(longTitle)
    expect(screen.getByText(longTitle.title)).not.toBeNull()
    expect(container.querySelector("[aria-expanded]")).toBeNull()
  })
})

describe("SauceCard title dismiss and swipe suppression", () => {
  it("a drag that dismisses an expanded title consumes the suppression flag, so the next tap toggles blur", () => {
    setSmallScreen(true)
    const onToggleBlur = vi.fn()
    render(
      <SauceCard sauce={longTitle} blurred={true} onToggleBlur={onToggleBlur} dimmed={false} />,
    )
    // Make this the active card so the swipe handlers are live.
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

    // Expand the condensed title.
    fireEvent.click(screen.getByRole("button", { name: "One two three four …" }))
    expect(screen.getByRole("button", { name: "Collapse title" })).not.toBeNull()

    // A drag on the tap layer that travels past the slop but short
    // of a page turn: no swipe fires, but the hook sets the
    // suppression flag for the click the browser fires on release.
    const tapLayer = screen.getByRole("button", { name: "Reveal image" })
    const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true }
    fireEvent.pointerDown(tapLayer, { ...pointer, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(tapLayer, { ...pointer, clientX: 185, clientY: 101 })
    fireEvent.pointerUp(tapLayer, { ...pointer, clientX: 170, clientY: 101 })
    fireEvent.click(tapLayer)

    // The release click dismissed the title and did not toggle blur…
    expect(screen.getByRole("button", { name: "One two three four …" })).not.toBeNull()
    expect(screen.queryByText(longTitle.title)).toBeNull()
    expect(onToggleBlur).not.toHaveBeenCalled()

    // …and the dismiss branch consumed the flag, so the next plain
    // tap reaches the blur toggle instead of being swallowed.
    fireEvent.click(tapLayer)
    expect(onToggleBlur).toHaveBeenCalledTimes(1)
  })
})

describe("SauceCard rail contents", () => {
  it("has no Reveal/Blur rail button; Source and page arrows remain", () => {
    renderCard(longTitle)
    // The rail's old blur-toggle button is gone. (The tap layer's
    // aria-label is "Reveal image"/"Blur image" — it must not trip
    // this check, so match the rail button's emoji labels exactly.)
    expect(screen.queryByRole("button", { name: /👁 Reveal|🙈 Blur/ })).toBeNull()
    expect(screen.getByRole("link", { name: /Source/ })).not.toBeNull()
    expect(screen.getByRole("button", { name: "Previous page" })).not.toBeNull()
    expect(screen.getByRole("button", { name: "Next page" })).not.toBeNull()
  })
})

describe("SauceCard dim mode", () => {
  it("hides header, rail and footer with the inert class set when dimmed", () => {
    const { container } = renderCard(longTitle, true)
    const chrome = [
      container.querySelector("header"),
      container.querySelector("footer"),
      screen.getByRole("link", { name: /Source/ }).parentElement,
    ]
    for (const el of chrome) {
      expect(el).not.toBeNull()
      expect(el!.className).toContain("opacity-0")
      expect(el!.className).toContain("invisible")
      expect(el!.className).toContain("pointer-events-none")
    }
  })

  it("leaves chrome visible when not dimmed", () => {
    const { container } = renderCard(longTitle, false)
    const footer = container.querySelector("footer")
    expect(footer!.className).toContain("opacity-100")
    expect(footer!.className).not.toContain("invisible")
  })
})
