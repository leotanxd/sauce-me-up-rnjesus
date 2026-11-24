import type { Sauce } from "../types"

const API_BASE = import.meta.env.VITE_API_BASE ?? "" // "" = Vite dev proxy

/** Sauces per fetch. Single source of truth for the frontend; the
 * backend's /api/sauce/batch default mirrors this value. */
export const BATCH_SIZE = 3

/** No fetch may hang forever: if the backend doesn't answer in 30s,
 * the request aborts and the feed shows its error/retry state. */
const FETCH_TIMEOUT_MS = 30_000

function apiFetch(path: string): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

// Demo fallback so the feed is scrollable/testable with no backend
// running — DEVELOPMENT BUILDS ONLY. In production a backend failure
// must surface as an error, never as fake placeholder content.
const DEMO_ENABLED = import.meta.env.DEV

const DEMO: Sauce[] = Array.from({ length: 6 }, (_, i) => ({
  id: 1000 + i,
  title: `Demo item ${i + 1} — start the backend for real results`,
  url: "#",
  firstImageUrl: `https://picsum.photos/seed/sauce-demo-${i}/720/1280`,
}))

let demoIdx = 0

function demoSauce(): Sauce {
  const item = DEMO[demoIdx % DEMO.length]
  demoIdx += 1
  return item
}

export async function fetchNextSauce(): Promise<Sauce> {
  try {
    const res = await apiFetch(`/api/sauce/next`)
    if (!res.ok) throw new Error(`API ${res.status}`)
    return (await res.json()) as Sauce
  } catch (error) {
    if (DEMO_ENABLED) return demoSauce()
    throw error
  }
}

/** All page image URLs for one gallery, in order (for arrow-key browsing). */
export async function fetchSaucePages(id: number): Promise<string[]> {
  const res = await apiFetch(`/api/sauce/${id}/pages`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = (await res.json()) as { images: string[] }
  return data.images
}

export async function fetchSauceBatch(n = BATCH_SIZE): Promise<Sauce[]> {
  try {
    const res = await apiFetch(`/api/sauce/batch?n=${n}`)
    if (!res.ok) throw new Error(`API ${res.status}`)
    const data = (await res.json()) as { items: Sauce[] }
    return data.items
  } catch (error) {
    if (DEMO_ENABLED) {
      return Array.from({ length: n }, () => demoSauce())
    }
    throw error
  }
}
