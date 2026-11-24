import type { FeedMode, Sauce } from "../types"
import { BATCH_SIZE, FETCH_TIMEOUT_MS } from "./config"

/** An API failure with its HTTP status preserved as data, so callers
 * can distinguish "not found" from "upstream down" without parsing
 * message strings. Message format is unchanged ("API 404"). */
export class ApiError extends Error {
  readonly status: number
  readonly path: string
  constructor(status: number, path: string) {
    super(`API ${status}`)
    this.name = "ApiError"
    this.status = status
    this.path = path
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "" // "" = Vite dev proxy

type QueryParams = Record<string, string | number | boolean | undefined>

function apiFetch(path: string, params?: QueryParams): Promise<Response> {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) qs.set(key, String(value))
  }
  const query = qs.toString()
  return fetch(`${API_BASE}${path}${query ? `?${query}` : ""}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

// Demo fallback so the feed is scrollable/testable with no backend
// running — DEVELOPMENT BUILDS ONLY. In production a backend failure
// must surface as an error, never as fake placeholder content. The
// dynamic import keeps the demo data out of the production bundle.
const DEMO_ENABLED = import.meta.env.DEV

async function demoSauce() {
  const { demoSauce: next } = await import("./demo")
  return next()
}

export async function fetchNextSauce(mode: FeedMode = "random"): Promise<Sauce> {
  try {
    const res = await apiFetch("/api/sauce/next", { mode })
    if (!res.ok) throw new ApiError(res.status, "/api/sauce/next")
    return (await res.json()) as Sauce
  } catch (error) {
    if (DEMO_ENABLED) return demoSauce()
    throw error
  }
}

/** All page image URLs for one gallery, in order (for arrow-key browsing). */
export async function fetchSaucePages(id: number): Promise<string[]> {
  const path = `/api/sauce/${id}/pages`
  const res = await apiFetch(path)
  if (!res.ok) throw new ApiError(res.status, path)
  const data = (await res.json()) as { images: string[] }
  return data.images
}

export async function fetchSauceBatch(n = BATCH_SIZE, mode: FeedMode = "random"): Promise<Sauce[]> {
  try {
    const res = await apiFetch("/api/sauce/batch", { n, mode })
    if (!res.ok) throw new ApiError(res.status, "/api/sauce/batch")
    const data = (await res.json()) as { items: Sauce[] }
    return data.items
  } catch (error) {
    if (DEMO_ENABLED) {
      const { demoSauce: next } = await import("./demo")
      return Array.from({ length: n }, () => next())
    }
    throw error
  }
}
