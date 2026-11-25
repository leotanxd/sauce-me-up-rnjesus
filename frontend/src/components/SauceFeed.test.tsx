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
    // Feed view up (the Dim pill exists only there), region quiet.
    await waitFor(() => expect(screen.getByRole("button", { name: "Dim: OFF" })).not.toBeNull())
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

