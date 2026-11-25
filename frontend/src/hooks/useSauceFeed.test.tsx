import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"
import { IntersectionObserverStub } from "../test/setup"

vi.mock("../lib/api", () => ({
  fetchNextSauce: vi.fn(),
  fetchSauceBatch: vi.fn(),
  fetchSaucePages: vi.fn(),
}))

import { fetchSauceBatch } from "../lib/api"
import { useSauceFeed } from "./useSauceFeed"

const mockBatch = vi.mocked(fetchSauceBatch)

const sauce = (id: number): Sauce => ({
  id,
  title: `Sauce ${id}`,
  url: `https://nhentai.net/g/${id}/`,
  firstImageUrl: `https://img.example/${id}.jpg`,
  pageCount: 5,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let hook!: ReturnType<typeof useSauceFeed>

function Harness() {
  hook = useSauceFeed()
  return (
    <main ref={hook.feedRef}>
      <div ref={hook.sentinelRef} />
    </main>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  IntersectionObserverStub.reset()
})

describe("useSauceFeed", () => {
  it("populates items from the initial load", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    render(<Harness />)
    await waitFor(() => expect(hook.items).toHaveLength(3))
    expect(hook.items.map((s) => s.id)).toEqual([1, 2, 3])
    expect(hook.error).toBeNull()
  })

  it("retries when a batch is all already-seen, without duplicating", async () => {
    mockBatch.mockResolvedValueOnce([sauce(1), sauce(2), sauce(3)])
    render(<Harness />)
    await waitFor(() => expect(hook.items).toHaveLength(3))

    // Top-up: first attempt returns only seen IDs, the retry is fresh.
    mockBatch
      .mockResolvedValueOnce([sauce(1), sauce(2), sauce(3)])
      .mockResolvedValueOnce([sauce(4), sauce(5)])
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

    await waitFor(() => expect(hook.items).toHaveLength(5))
    expect(hook.items.map((s) => s.id)).toEqual([1, 2, 3, 4, 5])
    expect(mockBatch).toHaveBeenCalledTimes(3)
  })

  it("discards a stale load that resolves after a mode switch", async () => {
    mockBatch.mockResolvedValueOnce([sauce(1)])
    render(<Harness />)
    await waitFor(() => expect(hook.items).toHaveLength(1))

    const popularLoad = deferred<Sauce[]>()
    mockBatch.mockReturnValueOnce(popularLoad.promise)
    act(() => hook.switchMode(true))
    expect(hook.popular).toBe(true)

    const randomLoad = deferred<Sauce[]>()
    mockBatch.mockReturnValueOnce(randomLoad.promise)
    act(() => hook.switchMode(false))
    expect(hook.popular).toBe(false)

    // The in-flight popular load resolves late — it must be discarded.
    await act(async () => {
      popularLoad.resolve([sauce(50), sauce(51)])
    })
    expect(hook.items).toHaveLength(0)

    await act(async () => {
      randomLoad.resolve([sauce(7), sauce(8)])
    })
    expect(hook.items.map((s) => s.id)).toEqual([7, 8])
  })

  it("derives the active index from scroll position for windowing", async () => {
    mockBatch.mockResolvedValue([sauce(1), sauce(2), sauce(3)])
    render(<Harness />)
    await waitFor(() => expect(hook.items).toHaveLength(3))

    const el = hook.feedRef.current
    if (!el) throw new Error("feed element not mounted")
    Object.defineProperty(el, "clientHeight", {
      value: 800,
      configurable: true,
    })

    el.scrollTop = 1600 // third card at rest (snap multiples)
    act(() => hook.onFeedScroll())
    expect(hook.activeIndex).toBe(2)

    el.scrollTop = 1700 // mid-scroll: still rounds to the nearest card
    act(() => hook.onFeedScroll())
    expect(hook.activeIndex).toBe(2)

    el.scrollTop = 0
    act(() => hook.onFeedScroll())
    expect(hook.activeIndex).toBe(0)
  })

  it("dimmed defaults to false and toggleDim flips it both ways", async () => {
    mockBatch.mockResolvedValue([sauce(1)])
    render(<Harness />)
    await waitFor(() => expect(hook.items).toHaveLength(1))
    expect(hook.dimmed).toBe(false)

    act(() => hook.toggleDim())
    expect(hook.dimmed).toBe(true)

    act(() => hook.toggleDim())
    expect(hook.dimmed).toBe(false)
  })

  it("leaves dimmed as it was across a mode switch", async () => {
    mockBatch.mockResolvedValue([sauce(1)])
    render(<Harness />)
    await waitFor(() => expect(hook.items).toHaveLength(1))

    act(() => hook.toggleDim())
    expect(hook.dimmed).toBe(true)

    mockBatch.mockResolvedValue([sauce(2)])
    act(() => hook.switchMode(true))
    expect(hook.popular).toBe(true)
    expect(hook.dimmed).toBe(true)
  })

  it("sets an error on failure and retry() recovers", async () => {
    mockBatch.mockRejectedValueOnce(new Error("backend down"))
    render(<Harness />)
    await waitFor(() => expect(hook.error).not.toBeNull())
    expect(hook.items).toHaveLength(0)

    mockBatch.mockResolvedValueOnce([sauce(9)])
    act(() => hook.retry())
    await waitFor(() => expect(hook.items).toHaveLength(1))
    expect(hook.items[0].id).toBe(9)
    expect(hook.error).toBeNull()
  })

  it("ignores arrow keys originating inside a control, scrolls from the body", async () => {
    mockBatch.mockResolvedValue([sauce(1)])
    // A harness with a chrome control for the event to originate
    // from (the plain Harness above has no focusable elements).
    function KeyHarness() {
      hook = useSauceFeed()
      return (
        <main ref={hook.feedRef}>
          <div ref={hook.sentinelRef} />
          <button type="button">Chrome control</button>
        </main>
      )
    }
    render(<KeyHarness />)
    await waitFor(() => expect(hook.items).toHaveLength(1))

    const el = hook.feedRef.current
    if (!el) throw new Error("feed element not mounted")
    const scrollBy = vi.fn()
    el.scrollBy = scrollBy

    // Focus sits on a chrome control: ↓ must not scroll the feed.
    fireEvent.keyDown(screen.getByRole("button", { name: "Chrome control" }), { key: "ArrowDown" })
    expect(scrollBy).not.toHaveBeenCalled()

    // The same key from the page body scrolls as always.
    fireEvent.keyDown(document.body, { key: "ArrowDown" })
    expect(scrollBy).toHaveBeenCalledTimes(1)
  })
})
