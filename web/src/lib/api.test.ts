import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchSaucePages } from "./api"
import { FETCH_TIMEOUT_MS } from "./config"

// fetchSaucePages is the probe: unlike the feed fetches it has no
// demo fallback, so what apiFetch does with the abort signal is
// directly observable through it. The older-engine simulation
// replaces AbortSignal.timeout (a plain writable static per
// WebIDL); afterEach restores whatever the engine actually has.

const timeoutSlot = AbortSignal as { timeout?: (ms: number) => AbortSignal }
const realTimeout = timeoutSlot.timeout

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  timeoutSlot.timeout = realTimeout
})

describe("api fetch timeout signal", () => {
  it("prefers native AbortSignal.timeout when the engine provides it", async () => {
    const native = vi.fn((_ms: number) => new AbortController().signal)
    timeoutSlot.timeout = native
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ images: ["https://img.example/1.jpg"] }),
    }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchSaucePages(7)).resolves.toEqual(["https://img.example/1.jpg"])
    expect(native).toHaveBeenCalledWith(FETCH_TIMEOUT_MS)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("falls back to an AbortController + timer where AbortSignal.timeout is missing", async () => {
    // An older engine (pre-Safari 16 / Chrome 103 / Firefox 100):
    // the static is absent, and apiFetch must not throw for it.
    timeoutSlot.timeout = undefined
    vi.useFakeTimers()
    // A fetch that hangs until its signal aborts, like a real one.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const promise = fetchSaucePages(7)
    const rejection = expect(promise).rejects.toThrowError(/aborted/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Nothing before the full timeout elapses…
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted).toBe(false)

    // …and the fallback timer aborts the fetch right at it.
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    expect(init.signal?.aborted).toBe(true)
  })
})
