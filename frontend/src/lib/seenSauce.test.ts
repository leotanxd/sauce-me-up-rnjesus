import { beforeEach, describe, expect, it } from "vitest"
import {
  capSeen,
  loadSeen,
  saveSeen,
  SEEN_CAP,
  SEEN_STORAGE_KEY,
} from "./seenSauce"

beforeEach(() => {
  window.localStorage.clear()
})

describe("seenSauce persistence", () => {
  it("round-trips both modes through localStorage", () => {
    saveSeen({ random: [1, 2, 3], popular: [9, 8] })
    expect(loadSeen()).toEqual({ random: [1, 2, 3], popular: [9, 8] })
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({
      random: [1, 2, 3],
      popular: [9, 8],
    })
  })

  it("returns empty lists when nothing was stored", () => {
    expect(loadSeen()).toEqual({ random: [], popular: [] })
  })

  it("treats corrupt JSON as empty", () => {
    window.localStorage.setItem(SEEN_STORAGE_KEY, "{not json")
    expect(loadSeen()).toEqual({ random: [], popular: [] })
  })

  it("treats a non-object payload as empty", () => {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(loadSeen()).toEqual({ random: [], popular: [] })
  })

  it("drops non-numeric and implausible entries, keeps valid IDs", () => {
    window.localStorage.setItem(
      SEEN_STORAGE_KEY,
      JSON.stringify({
        random: [1, "2", null, 3.5, -4, 0, 5, Number.NaN],
        popular: "not-an-array",
      }),
    )
    expect(loadSeen()).toEqual({ random: [1, 5], popular: [] })
  })

  it("dedupes stored IDs, preserving first-seen order", () => {
    window.localStorage.setItem(
      SEEN_STORAGE_KEY,
      JSON.stringify({ random: [7, 7, 8, 7], popular: [] }),
    )
    expect(loadSeen().random).toEqual([7, 8])
  })

  it("keeps the two modes independent", () => {
    saveSeen({ random: [1], popular: [] })
    saveSeen({ random: [1], popular: [2] })
    expect(loadSeen()).toEqual({ random: [1], popular: [2] })
  })

  it("caps each mode at SEEN_CAP, keeping the most recent IDs", () => {
    const ids = Array.from({ length: SEEN_CAP + 10 }, (_, i) => i + 1)
    saveSeen({ random: ids, popular: [] })
    const loaded = loadSeen()
    expect(loaded.random).toHaveLength(SEEN_CAP)
    expect(loaded.random[0]).toBe(11) // the oldest 10 rolled off
    expect(loaded.random.at(-1)).toBe(SEEN_CAP + 10)
  })

  it("capSeen trims a long list to its newest SEEN_CAP entries", () => {
    const ids = Array.from({ length: SEEN_CAP + 1 }, (_, i) => i + 1)
    expect(capSeen(ids)).toEqual(ids.slice(1))
    expect(capSeen([1, 2])).toEqual([1, 2])
  })

  it("never throws when storage itself throws", () => {
    const getItem = window.localStorage.getItem.bind(window.localStorage)
    const setItem = window.localStorage.setItem.bind(window.localStorage)
    window.localStorage.getItem = () => {
      throw new Error("storage disabled")
    }
    window.localStorage.setItem = () => {
      throw new Error("storage disabled")
    }
    try {
      expect(loadSeen()).toEqual({ random: [], popular: [] })
      expect(() => saveSeen({ random: [1], popular: [] })).not.toThrow()
    } finally {
      window.localStorage.getItem = getItem
      window.localStorage.setItem = setItem
    }
  })
})
