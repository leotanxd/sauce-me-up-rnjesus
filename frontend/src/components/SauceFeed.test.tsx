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
// single feed-level pill. Mounted neighbour cards are aria-hidden
// (off-screen treatment), so presence checks must include hidden
// elements — `hidden: true` is exactly that.
const dimOffButtons = () =>
  screen.getAllByRole("button", { name: "Dim: OFF", hidden: true })

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

    // A full 3-item batch: a shorter first batch would put the
    // fresh feed inside the top-up zone (second-to-last = first
    // card), and its top-up against this standing mock would
    // legitimately exhaust and announce that instead.
    mockBatch.mockResolvedValue([sauce(10), sauce(11), sauce(12)])
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

describe("SauceFeed a11y: mode label and off-screen cards", () => {
  it("labels <main> for the current mode and updates the label on switch", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    const { container } = render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))
    expect(container.querySelector("main")?.getAttribute("aria-label")).toBe(
      "Random sauce feed",
    )

    mockBatch.mockResolvedValue([sauce(10), sauce(11), sauce(12)])
    fireEvent.click(screen.getByRole("button", { name: "Popular" }))
    await waitFor(() =>
      expect(container.querySelector("main")?.getAttribute("aria-label")).toBe(
        "Popular sauce feed",
      ),
    )
  })

  it("keeps mounted neighbour cards inert and aria-hidden; the current card stays live", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    const { container } = render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))

    const articles = [...container.querySelectorAll("article")]
    expect(articles).toHaveLength(3)
    // The current card (index 0) is fully exposed and interactive.
    expect(articles[0].getAttribute("aria-hidden")).toBeNull()
    expect((articles[0] as HTMLElement).inert).toBe(false)
    // Its mounted neighbours are out of the tab order and the
    // accessibility tree until scrolled to.
    for (const article of articles.slice(1)) {
      expect(article.getAttribute("aria-hidden")).toBe("true")
      expect((article as HTMLElement).inert).toBe(true)
    }
    // Role queries agree: only the current card's controls are
    // reachable without opting into hidden elements.
    expect(screen.getAllByRole("button", { name: "Dim: OFF" })).toHaveLength(1)
  })
})

describe("SauceFeed Dim placement", () => {
  it("renders one per-card Dim toggle per mounted card, inside the corner-anchored column", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))
    for (const dim of dimOffButtons()) {
      expect(dim.className).not.toContain("fixed")
      const column = dim.parentElement!
      expect(column.className).toContain("bottom-[max(1rem,env(safe-area-inset-bottom))]")
      expect(column.className).toContain("right-[max(1rem,env(safe-area-inset-right))]")
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

describe("SauceFeed UI zoom", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  const wrapperOf = (container: HTMLElement) =>
    container.querySelector("main")!.parentElement as HTMLElement

  it("publishes --ui-zoom on the wrapper and marks exactly the chrome groups .ui-zoom", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    const { container } = render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))

    const wrapper = wrapperOf(container)
    expect(wrapper.style.getPropertyValue("--ui-zoom")).toBe("1")

    // The scaled set: card header, the right column (rail + Dim +
    // title/# as one unit), ModeToggle root. Cards have no footer
    // any more — the Page X of Y line lives in the column.
    expect(container.querySelector("header")!.className).toContain("ui-zoom")
    expect(container.querySelector("footer")).toBeNull()
    expect(dimOffButtons()[0].parentElement!.className).toContain("ui-zoom")
    expect(screen.getByRole("group", { name: "Feed mode" }).className).toContain("ui-zoom")

    // Exhaustive per-card inventory: within the first card, exactly
    // two elements carry ui-zoom — the header and the right-column
    // container (the image-error panel is absent in this render).
    // Anything else gaining the class would double-scale, since
    // nested zoom compounds — e.g. the Page X of Y line must scale
    // only by inheritance through the column, never on its own.
    const article = container.querySelector("article")!
    const cardZoomed = [...article.querySelectorAll(".ui-zoom")]
    expect(cardZoomed).toHaveLength(2)
    expect(cardZoomed).toContain(article.querySelector("header"))
    expect(cardZoomed).toContain(dimOffButtons()[0].parentElement)

    // Never scaled: the artwork subtree, the tap layer, the card
    // and feed geometry, placeholders.
    const img = container.querySelector("img")!
    expect(img.className).not.toContain("ui-zoom")
    expect((img as HTMLElement).style.getPropertyValue("zoom")).toBe("")
    const zoomLayer = container.querySelector(".sauce-zoom-layer")!
    expect(zoomLayer.className).not.toContain("ui-zoom")
    const slideWrapper = zoomLayer.parentElement!
    expect(slideWrapper.className).not.toContain("ui-zoom")
    expect(screen.getAllByRole("button", { name: "Reveal image" })[0].className).not.toContain("ui-zoom")
    expect(container.querySelector("article")!.className).not.toContain("ui-zoom")
    expect(container.querySelector("main")!.className).not.toContain("ui-zoom")
  })

  it("Ctrl+Shift+wheel over the feed steps --ui-zoom; Ctrl+wheel leaves it alone", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    const { container } = render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))
    const wrapper = wrapperOf(container)

    const uiEvt = new WheelEvent("wheel", {
      ctrlKey: true,
      shiftKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      wrapper.dispatchEvent(uiEvt)
    })
    expect(uiEvt.defaultPrevented).toBe(true)
    expect(parseFloat(wrapper.style.getPropertyValue("--ui-zoom"))).toBeCloseTo(1.16, 2)

    const imgEvt = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      wrapper.dispatchEvent(imgEvt)
    })
    expect(parseFloat(wrapper.style.getPropertyValue("--ui-zoom"))).toBeCloseTo(1.16, 2)
  })

  it("the mid-feed error bar's pill carries ui-zoom (its fixed wrapper does not scale)", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    render(<SauceFeed />)
    await waitFor(() => expect(dimOffButtons()).toHaveLength(3))

    // Fail the next top-up: the error bar appears.
    mockBatch.mockRejectedValue(new Error("backend down"))
    const sentinelObserver = IntersectionObserverStub.instances.find((o) =>
      [...o.elements].some((el) => (el as HTMLElement).className.includes("h-px")),
    )
    expect(sentinelObserver).toBeTruthy()
    await act(async () => {
      sentinelObserver!.trigger([{ isIntersecting: true, intersectionRatio: 1 }])
    })

    const retry = await screen.findByRole("button", { name: "Retry" })
    const pill = retry.parentElement!
    expect(pill.className).toContain("ui-zoom")
    expect(pill.parentElement!.className).not.toContain("ui-zoom")
  })
})
