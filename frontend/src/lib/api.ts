import type { Sauce } from "../types"

const API_BASE = import.meta.env.VITE_API_BASE ?? "" // "" = Vite dev proxy

// Demo fallback so the feed is scrollable/testable with no backend running.
// These are neutral placeholders — no source imagery.
const DEMO: Sauce[] = Array.from({ length: 6 }, (_, i) => ({
  id: 1000 + i,
  title: `Demo item ${i + 1} — start the backend for real results`,
  url: "#",
  firstImageUrl: `https://picsum.photos/seed/sauce-demo-${i}/720/1280`,
}))

let demoIdx = 0

export async function fetchNextSauce(): Promise<Sauce> {
  try {
    const res = await fetch(`${API_BASE}/api/sauce/next`)
    if (!res.ok) throw new Error(`API ${res.status}`)
    return (await res.json()) as Sauce
  } catch {
    const item = DEMO[demoIdx % DEMO.length]
    demoIdx += 1
    return item
  }
}

/** All page image URLs for one gallery, in order (for arrow-key browsing). */
export async function fetchSaucePages(id: number): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/sauce/${id}/pages`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  const data = (await res.json()) as { images: string[] }
  return data.images
}

export async function fetchSauceBatch(n = 3): Promise<Sauce[]> {
  try {
    const res = await fetch(`${API_BASE}/api/sauce/batch?n=${n}`)
    if (!res.ok) throw new Error(`API ${res.status}`)
    const data = (await res.json()) as { items: Sauce[] }
    return data.items
  } catch {
    return Promise.all(Array.from({ length: n }, () => fetchNextSauce()))
  }
}
