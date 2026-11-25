import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"
import { IntersectionObserverStub } from "../test/setup"

vi.mock("../lib/api", () => ({
  fetchNextSauce: vi.fn(),
  fetchSauceBatch: vi.fn(),
  fetchSaucePages: vi.fn(),
}))

// Cards page through the load gate; stub it resolved (cache-hot),
// as the card tests do — jsdom's Image never fires load.
vi.mock("../lib/waitForImage", () => ({
  waitForImage: vi.fn(() => Promise.resolve()),
}))

import SauceFeed from "./SauceFeed"
import ModeToggle from "./ModeToggle"
import { fetchSauceBatch, fetchSaucePages } from "../lib/api"

const mockBatch = vi.mocked(fetchSauceBatch)

const sauce = (id: number): Sauce => ({
  id,
  title: `Sauce ${id}`,
  url: `https://nhentai.net/g/${id}/`,
  firstImageUrl: `https://img.example/${id}.jpg`,
  pageCount: 5,
})

const region = (container: HTMLElement) => container.querySelector("[aria-live='polite']")

// Dim is rendered per card now (it scrolls with the card), so a
// loaded feed shows one Dim: OFF button per mounted card — never a
// single feed-level pill.
const dimOffButtons = () => screen.getAllByRole("button", { name: "Dim: OFF" })

beforeEach(() => {
  vi.resetAllMocks()
  IntersectionObserverStub.reset()
  vi.mocked(fetchSaucePages).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
})

describe("SauceFeed live region", () => {
  it("announces the new mode after a switch", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    const { container } = render(<SauceFeed />)
    // Feed view up (per-card Dim pills exist only there), region quiet.
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))
    expect(region(container)?.textContent).toBe("")

    mockBatch.mockResolvedValue([sauce(10), sauce(11)])
    fireEvent.click(screen.getByRole("button", { name: "Popular" }))
    await waitFor(() => expect(region(container)?.textContent).toBe("Popular feed"))
  })

  it("announces a load error", async () => {
    mockBatch.mockRejectedValue(new Error("backend down"))
    const { container } = render(<SauceFeed />)
    await waitFor(() =>
      expect(region(container)?.textContent).toBe(
        "Could not load sauce. Check your connection and try again.",
      ),
    )
  })
})

describe("SauceFeed Dim placement", () => {
  it("renders one per-card (absolute, not fixed) Dim toggle per mounted card", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))
    for (const dim of dimOffButtons()) {
      expect(dim.className).toContain("absolute")
      expect(dim.className).not.toContain("fixed")
      expect(dim.className).toContain("bottom-[282px]")
    }
  })
})

describe("SauceFeed mode-switch fade", () => {
  it("holds the switch until the fade-out elapses", async () => {
    vi.useFakeTimers()
    try {
      mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
      render(<SauceFeed />)
      await act(async () => {})
      expect(dimOffButtons()).toHaveLength(3)

      mockBatch.mockClear()
      mockBatch.mockResolvedValue([sauce(10)])
      fireEvent.click(screen.getByRole("button", { name: "Popular" }))
      // Fade-out in progress: no fetch for the new mode yet.
      expect(mockBatch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(170)
      })
      expect(mockBatch).toHaveBeenCalledWith(3, "popular")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a re-click during the fade cancels the pending switch and honours the latest choice", async () => {
    vi.useFakeTimers()
    try {
      mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
      const { container } = render(<SauceFeed />)
      await act(async () => {})
      expect(dimOffButtons()).toHaveLength(3)

      mockBatch.mockClear()
      fireEvent.click(screen.getByRole("button", { name: "Popular" }))
      expect(container.querySelector("main")?.className).toContain("opacity-0")

      // Changed his mind mid-fade: back to Random. The fade must
      // cancel on the spot — no pending Popular switch may land.
      fireEvent.click(screen.getByRole("button", { name: "Random" }))
      expect(container.querySelector("main")?.className).not.toContain("opacity-0")

      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
      expect(mockBatch).not.toHaveBeenCalled()
      // Still the random feed, still showing its cards.
      expect(dimOffButtons()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("ModeToggle focus ring", () => {
  it("gives the selected (ember-filled) button a white ring, the other an ember ring", () => {
    render(<ModeToggle popular={false} onSwitch={() => {}} />)
    const random = screen.getByRole("button", { name: "Random" })
    const popular = screen.getByRole("button", { name: "Popular" })
    // Random is selected: an ember ring would vanish on its ember
    // fill, so it gets the white ring instead.
    expect(random.className).toContain("bg-ember")
    expect(random.className).toContain("focus-visible:ring-white")
    expect(random.className).not.toContain("focus-visible:ring-ember")
    // Popular is unselected: the ember ring, unchanged.
    expect(popular.className).toContain("focus-visible:ring-ember")
    expect(popular.className).not.toContain("focus-visible:ring-white")
    // Both rings stay inset (the group container clips overflow).
    expect(random.className).toContain("focus-visible:ring-inset")
    expect(popular.className).toContain("focus-visible:ring-inset")
  })

  it("moves the white ring with the selection", () => {
    render(<ModeToggle popular={true} onSwitch={() => {}} />)
    const popular = screen.getByRole("button", { name: "Popular" })
    const random = screen.getByRole("button", { name: "Random" })
    expect(popular.className).toContain("bg-ember")
    expect(popular.className).toContain("focus-visible:ring-white")
    expect(popular.className).not.toContain("focus-visible:ring-ember")
    expect(random.className).toContain("focus-visible:ring-ember")
    expect(random.className).not.toContain("focus-visible:ring-white")
  })
})
