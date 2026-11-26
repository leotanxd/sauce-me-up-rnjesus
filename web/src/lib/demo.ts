import type { Sauce } from "../types"

/** Development-only demo data. Loaded exclusively through the dynamic
 * import in lib/api.ts (guarded by import.meta.env.DEV), so production
 * bundles exclude this module entirely. Lets the feed be scrolled and
 * tested with no backend running; production failures surface as real
 * errors instead. */

const DEMO: Sauce[] = Array.from({ length: 6 }, (_, i) => ({
  id: 1000 + i,
  title: `Demo item ${i + 1} — start the backend for real results`,
  url: "#",
  firstImageUrl: `https://picsum.photos/seed/sauce-demo-${i}/720/1280`,
  pageCount: null,
}))

let demoIdx = 0

export function demoSauce(): Sauce {
  const item = DEMO[demoIdx % DEMO.length]
  demoIdx += 1
  return item
}
