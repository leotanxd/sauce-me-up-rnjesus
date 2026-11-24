import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"
import { setSmallScreen } from "../test/setup"

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

function renderCard(sauce: Sauce) {
  return render(<SauceCard sauce={sauce} blurred={true} onToggleBlur={() => {}} />)
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
