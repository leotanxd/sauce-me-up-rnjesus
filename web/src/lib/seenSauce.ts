import type { FeedMode } from "../types"

/**
 * The client's persistent seen memory: the gallery IDs this browser
 * has already been served, per feed mode, kept in localStorage.
 *
 * This is the only repeat defence that survives BOTH failure
 * boundaries at once — a page refresh (which resets the feed hook's
 * in-memory seen set) and a server restart (which wipes the
 * server's in-process no-repeat window). The uiZoom persistence
 * (lib/uiZoom.ts) is the precedent: a small, local-only preference
 * that never leaves the browser.
 *
 * Each mode's list is capped at SEEN_CAP IDs, FIFO: appending past
 * the cap drops the oldest, so a gallery can return only after
 * SEEN_CAP newer ones have been seen. No expiry, no toggle.
 */

/** localStorage key for the per-mode seen lists. */
export const SEEN_STORAGE_KEY = "sauce-seen-ids"
/** Per-mode memory horizon (Leo's choice, 2026-11-25). */
export const SEEN_CAP = 500

export type SeenLists = Record<FeedMode, number[]>

const MODES: FeedMode[] = ["random", "popular"]

function emptySeen(): SeenLists {
  return { random: [], popular: [] }
}

/** Keep only plausible gallery IDs (positive integers), deduped,
 * order preserved — stored data is untrusted input. */
function sanitizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  const ids: number[] = []
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0) {
      continue
    }
    if (seen.has(entry)) continue
    seen.add(entry)
    ids.push(entry)
  }
  return ids
}

/** Trim a list to the most recent SEEN_CAP entries (FIFO). */
export function capSeen(ids: number[]): number[] {
  return ids.length > SEEN_CAP ? ids.slice(ids.length - SEEN_CAP) : ids
}

/**
 * Load the persisted seen lists. Corrupt JSON, wrong shapes, and
 * non-numeric entries all degrade to empty lists, and a storage
 * failure (private browsing, disabled storage) does the same —
 * the feed must never break over its own memory.
 */
export function loadSeen(): SeenLists {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY)
    if (raw === null) return emptySeen()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return emptySeen()
    const record = parsed as Record<string, unknown>
    const lists = emptySeen()
    for (const mode of MODES) {
      lists[mode] = capSeen(sanitizeIds(record[mode]))
    }
    return lists
  } catch {
    return emptySeen()
  }
}

/** Persist the seen lists (each capped). Never throws. */
export function saveSeen(seen: SeenLists): void {
  try {
    const capped: SeenLists = {
      random: capSeen(seen.random),
      popular: capSeen(seen.popular),
    }
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(capped))
  } catch {
    // Non-fatal: the in-memory seen set still covers this session.
  }
}
