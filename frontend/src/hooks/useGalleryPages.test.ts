import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"

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
})
