import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"
import { IntersectionObserverStub } from "../test/setup"

vi.mock("../lib/api", () => ({
  fetchNextSauce: vi.fn(),
  fetchSauceBatch: vi.fn(),
  fetchSaucePages: vi.fn(),
}))

import { fetchSaucePages } from "../lib/api"
import { useGalleryPages } from "./useGalleryPages"

const mockPages = vi.mocked(fetchSaucePages)

const sauce: Sauce = {
  id: 42,
  title: "Gallery 42",
  url: "https://nhentai.net/g/42/",
  firstImageUrl: "https://img.example/first.jpg",
  pageCount: 10,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const pageUrls = (n: number) =>
  Array.from({ length: n }, (_, i) => `https://img.example/${i + 1}.jpg`)

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useGalleryPages", () => {
  it("accumulates arrow presses during the fetch and lands clamped", async () => {
    const fetch = deferred<string[]>()
    mockPages.mockReturnValue(fetch.promise)
    const { result } = renderHook(() => useGalleryPages(sauce))

    // Three presses while the page list is still loading.
    void result.current.goToPage(1)
    void result.current.goToPage(1)
    void result.current.goToPage(1)
    expect(mockPages).toHaveBeenCalledTimes(1)

    await act(async () => {
      fetch.resolve(pageUrls(10))
    })
    expect(result.current.pageIdx).toBe(3)
    expect(result.current.totalPages).toBe(10)

    // Once loaded, further presses clamp at the last page.
    await act(async () => {
      for (let i = 0; i < 20; i++) await result.current.goToPage(1)
    })
    expect(result.current.pageIdx).toBe(9)
  })

  it("does not cache a failed page fetch — the next press retries", async () => {
    mockPages.mockRejectedValueOnce(new Error("upstream down"))
    const { result } = renderHook(() => useGalleryPages(sauce))

    await act(async () => {
      await result.current.goToPage(1)
    })
    expect(result.current.pageIdx).toBe(0)
    expect(mockPages).toHaveBeenCalledTimes(1)

    mockPages.mockResolvedValueOnce(pageUrls(3))
    await act(async () => {
      await result.current.goToPage(1)
    })
    expect(mockPages).toHaveBeenCalledTimes(2)
    // The failed press's delta is not lost: it stays accumulated and
    // applies together with the retrying press, landing on page 3.
    expect(result.current.pageIdx).toBe(2)
    expect(result.current.currentSrc).toBe("https://img.example/3.jpg")
  })

  it("preloads the next page once the list is loaded", async () => {
    const preloaded: string[] = []
    class FakeImage {
      set src(value: string) {
        preloaded.push(value)
      }
    }
    vi.stubGlobal("Image", FakeImage)

    mockPages.mockResolvedValue(pageUrls(3))
    const { result } = renderHook(() => useGalleryPages(sauce))
    await act(async () => {
      await result.current.goToPage(1)
    })

    // Having landed on page 2 (index 1), the preload targets page 3.
    await waitFor(() => expect(preloaded.length).toBeGreaterThan(0))
    expect(preloaded).toContain("https://img.example/3.jpg")
  })

  it("preloads the previous page too once paging has moved", async () => {
    const preloaded: string[] = []
    class FakeImage {
      set src(value: string) {
        preloaded.push(value)
      }
    }
    vi.stubGlobal("Image", FakeImage)

    mockPages.mockResolvedValue(pageUrls(3))
    const { result } = renderHook(() => useGalleryPages(sauce))
    await act(async () => {
      await result.current.goToPage(1)
    })

    // On page 2 (index 1), BOTH neighbours are preloaded — the
    // previous page included, so a back-swipe is gated on a
    // cache-hot image just like a forward one.
    await waitFor(() => expect(preloaded).toContain("https://img.example/1.jpg"))
    expect(preloaded).toContain("https://img.example/3.jpg")
  })

  // The dwell prefetch needs an "active" card, which renderHook
  // can't produce (it never attaches cardRef to an element) — so
  // these two tests drive the hook through a tiny harness element.
  let harnessLatest!: ReturnType<typeof useGalleryPages>
  function Harness() {
    harnessLatest = useGalleryPages(sauce)
    return createElement("article", { ref: harnessLatest.cardRef })
  }
  const activateCard = () =>
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

  it("prefetches the page list after ~700 ms of dwell, silently", async () => {
    vi.useFakeTimers()
    try {
      mockPages.mockResolvedValue(pageUrls(3))
      render(createElement(Harness))

      // Not active yet: no fetch, however long we wait.
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      expect(mockPages).not.toHaveBeenCalled()

      activateCard()
      // Before the dwell elapses: still no fetch.
      await act(async () => {
        vi.advanceTimersByTime(699)
      })
      expect(mockPages).not.toHaveBeenCalled()

      // Dwell elapses: the prefetch fires — and stays silent (the
      // "Loading pages…" signal is for paging presses only).
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(mockPages).toHaveBeenCalledTimes(1)
      expect(harnessLatest.loadingPages).toBe(false)
      expect(harnessLatest.totalPages).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not prefetch if the card stops being viewed before the dwell", async () => {
    vi.useFakeTimers()
    try {
      mockPages.mockResolvedValue(pageUrls(3))
      render(createElement(Harness))
      activateCard()
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      // Scrolled away before 700 ms: the timer is cleared.
      act(() => {
        IntersectionObserverStub.latest().trigger([
          { isIntersecting: false, intersectionRatio: 0 },
        ])
      })
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      expect(mockPages).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // The keyboard guard needs a real control in the tree for the
  // event to originate from — a harness card with a chrome button.
  function KeyHarness() {
    harnessLatest = useGalleryPages(sauce)
    return createElement(
      "article",
      { ref: harnessLatest.cardRef },
      createElement("button", { type: "button" }, "Chrome control"),
    )
  }

  it("ignores arrow keys originating inside a control, pages from the body", async () => {
    vi.useFakeTimers()
    try {
      mockPages.mockResolvedValue(pageUrls(3))
      render(createElement(KeyHarness))
      activateCard()
      // Dwell prefetch loads the page list (silently).
      await act(async () => {
        vi.advanceTimersByTime(700)
      })
      expect(harnessLatest.totalPages).toBe(3)
      expect(harnessLatest.pageIdx).toBe(0)

      // Focus sits on a chrome control: → must not page.
      const control = screen.getByRole("button", { name: "Chrome control" })
      await act(async () => {
        fireEvent.keyDown(control, { key: "ArrowRight" })
      })
      expect(harnessLatest.pageIdx).toBe(0)

      // The same key from the page body pages as always.
      await act(async () => {
        fireEvent.keyDown(document.body, { key: "ArrowRight" })
      })
      expect(harnessLatest.pageIdx).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
