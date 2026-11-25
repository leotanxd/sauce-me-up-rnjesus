import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Sauce } from "../types"
import { IntersectionObserverStub, setSmallScreen } from "../test/setup"

vi.mock("../lib/api", () => ({
  fetchNextSauce: vi.fn(),
  fetchSauceBatch: vi.fn(),
  fetchSaucePages: vi.fn(),
}))

// The load gate: jsdom's Image never fires load, so the wait is
// stubbed — resolved by default (a cache-hot image), controllable
// per test where the gate's timing is the point.
vi.mock("../lib/waitForImage", () => ({
  waitForImage: vi.fn(() => Promise.resolve()),
}))

// Natural-size measurement (strip detection): same treatment —
// null (unknown size → normal page) by default, scripted per src
// in the strip tests.
vi.mock("../lib/loadImageMeta", () => ({
  loadImageMeta: vi.fn(() => Promise.resolve(null)),
}))

import SauceCard from "./SauceCard"
import { fetchSaucePages } from "../lib/api"
import { loadImageMeta } from "../lib/loadImageMeta"
import { waitForImage } from "../lib/waitForImage"

const mockWaitForImage = vi.mocked(waitForImage)
const mockLoadImageMeta = vi.mocked(loadImageMeta)

const longTitle: Sauce = {
  id: 7,
  title: "One two three four five six seven eight nine",
  url: "https://nhentai.net/g/7/",
  firstImageUrl: "https://img.example/7.jpg",
  pageCount: 12,
}

const shortTitle: Sauce = { ...longTitle, id: 8, title: "Short little title" }

function renderCard(sauce: Sauce, dimmed = false, onToggleDim = () => {}) {
  return render(
    <SauceCard
      sauce={sauce}
      blurred={true}
      onToggleBlur={() => {}}
      dimmed={dimmed}
      onToggleDim={onToggleDim}
    />,
  )
}

afterEach(() => {
  cleanup()
  setSmallScreen(false)
})

describe("SauceCard titles on small screens", () => {
  it("condenses a >4-word title to 4 words + … and expands on tap", () => {
    setSmallScreen(true)
    renderCard(longTitle)

    const toggle = screen.getByRole("button", { name: "One two three four …" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText(longTitle.title)).toBeNull()

    fireEvent.click(toggle)
    const panel = screen.getByRole("button", { name: "Collapse title" })
    expect(panel.getAttribute("aria-expanded")).toBe("true")
    expect(panel.className).toContain("max-w-44")
    expect(screen.getByText(longTitle.title)).not.toBeNull()

    fireEvent.click(panel)
    expect(screen.getByRole("button", { name: "One two three four …" })).not.toBeNull()
    expect(screen.queryByText(longTitle.title)).toBeNull()
  })

  it("renders a ≤4-word title in full with no expand button", () => {
    setSmallScreen(true)
    const { container } = renderCard(shortTitle)
    expect(screen.getByText("Short little title")).not.toBeNull()
    expect(container.querySelector("[aria-expanded]")).toBeNull()
  })
})

describe("SauceCard titles on desktop", () => {
  it("renders the full title as plain text with no expand button", () => {
    setSmallScreen(false)
    const { container } = renderCard(longTitle)
    expect(screen.getByText(longTitle.title)).not.toBeNull()
    expect(container.querySelector("[aria-expanded]")).toBeNull()
  })
})

describe("SauceCard title dismiss and swipe suppression", () => {
  it("a drag that dismisses an expanded title consumes the suppression flag, so the next tap toggles blur", () => {
    setSmallScreen(true)
    const onToggleBlur = vi.fn()
    render(
      <SauceCard
        sauce={longTitle}
        blurred={true}
        onToggleBlur={onToggleBlur}
        dimmed={false}
        onToggleDim={() => {}}
      />,
    )
    // Make this the active card so the swipe handlers are live.
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

    // Expand the condensed title.
    fireEvent.click(screen.getByRole("button", { name: "One two three four …" }))
    expect(screen.getByRole("button", { name: "Collapse title" })).not.toBeNull()

    // A drag on the tap layer that travels past the slop but short
    // of a page turn: no swipe fires, but the hook sets the
    // suppression flag for the click the browser fires on release.
    const tapLayer = screen.getByRole("button", { name: "Reveal image" })
    const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true }
    fireEvent.pointerDown(tapLayer, { ...pointer, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(tapLayer, { ...pointer, clientX: 185, clientY: 101 })
    fireEvent.pointerUp(tapLayer, { ...pointer, clientX: 170, clientY: 101 })
    fireEvent.click(tapLayer)

    // The release click dismissed the title and did not toggle blur…
    expect(screen.getByRole("button", { name: "One two three four …" })).not.toBeNull()
    expect(screen.queryByText(longTitle.title)).toBeNull()
    expect(onToggleBlur).not.toHaveBeenCalled()

    // …and the dismiss branch consumed the flag, so the next plain
    // tap reaches the blur toggle instead of being swallowed.
    fireEvent.click(tapLayer)
    expect(onToggleBlur).toHaveBeenCalledTimes(1)
  })
})

describe("SauceCard tap layer focus ring", () => {
  it("carries no focus ring (a ring would frame the whole viewport) but stays a focusable, labelled button", () => {
    const onToggleBlur = vi.fn()
    render(
      <SauceCard
        sauce={longTitle}
        blurred={true}
        onToggleBlur={onToggleBlur}
        dimmed={false}
        onToggleDim={() => {}}
      />,
    )
    const tapLayer = screen.getByRole("button", { name: "Reveal image" })
    // Regression: the tap layer once carried focus-visible ring
    // classes; after a click focused it, Space/Enter surfaced a
    // full-screen ember border Leo couldn't dismiss.
    expect(tapLayer.className).not.toContain("ring-2")
    expect(tapLayer.className).not.toContain("ring-inset")
    expect(tapLayer.className).not.toContain("ring-ember")
    expect(tapLayer.className).toContain("focus-visible:outline-none")
    // Still a real focusable button: focus lands on it, and
    // activation (what Space/Enter dispatch) still toggles blur.
    tapLayer.focus()
    expect(document.activeElement).toBe(tapLayer)
    fireEvent.click(tapLayer)
    expect(onToggleBlur).toHaveBeenCalledTimes(1)
  })
})

describe("SauceCard rail contents", () => {
  it("has no Reveal/Blur rail button; Source and page arrows remain", () => {
    renderCard(longTitle)
    // The rail's old blur-toggle button is gone. (The tap layer's
    // aria-label is "Reveal image"/"Blur image" — it must not trip
    // this check, so match the rail button's emoji labels exactly.)
    expect(screen.queryByRole("button", { name: /👁 Reveal|🙈 Blur/ })).toBeNull()
    expect(screen.getByRole("link", { name: /Source/ })).not.toBeNull()
    expect(screen.getByRole("button", { name: "Previous page" })).not.toBeNull()
    expect(screen.getByRole("button", { name: "Next page" })).not.toBeNull()
  })
})

describe("SauceCard dim mode", () => {
  it("hides header, rail and footer with the inert class set when dimmed", () => {
    const { container } = renderCard(longTitle, true)
    const chrome = [
      container.querySelector("header"),
      container.querySelector("footer"),
      screen.getByRole("link", { name: /Source/ }).parentElement,
    ]
    for (const el of chrome) {
      expect(el).not.toBeNull()
      expect(el!.className).toContain("opacity-0")
      expect(el!.className).toContain("invisible")
      expect(el!.className).toContain("pointer-events-none")
    }
  })

  it("leaves chrome visible when not dimmed", () => {
    const { container } = renderCard(longTitle, false)
    const footer = container.querySelector("footer")
    expect(footer!.className).toContain("opacity-100")
    expect(footer!.className).not.toContain("invisible")
  })
})

describe("SauceCard Dim toggle", () => {
  it("renders the Dim pill in the card at the rail's column geometry and toggles on click", () => {
    const onToggleDim = vi.fn()
    renderCard(longTitle, false, onToggleDim)

    const dim = screen.getByRole("button", { name: "Dim: OFF" })
    expect(dim.getAttribute("aria-pressed")).toBe("false")
    // Per-card (absolute), not the old feed-level fixed pill.
    expect(dim.className).toContain("absolute")
    expect(dim.className).not.toContain("fixed")
    expect(dim.className).toContain("right-[max(1rem,env(safe-area-inset-right))]")
    expect(dim.className).toContain("bottom-[282px]")
    expect(dim.className).toContain("[@media(max-height:560px)]:bottom-[218px]")

    fireEvent.click(dim)
    expect(onToggleDim).toHaveBeenCalledTimes(1)
  })

  it("stays visible and clickable at reduced opacity while dimmed — it is the only exit", () => {
    const onToggleDim = vi.fn()
    renderCard(longTitle, true, onToggleDim)

    const dim = screen.getByRole("button", { name: "Dim: ON" })
    expect(dim.getAttribute("aria-pressed")).toBe("true")
    expect(dim.className).toContain("opacity-40")
    expect(dim.className).toContain("hover:opacity-100")
    expect(dim.className).toContain("focus-visible:opacity-100")
    // Never the chrome hide set.
    expect(dim.className).not.toContain("opacity-0")
    expect(dim.className).not.toContain("invisible")
    expect(dim.className).not.toContain("pointer-events-none")

    fireEvent.click(dim)
    expect(onToggleDim).toHaveBeenCalledTimes(1)
  })
})

describe("SauceCard page-turn animation (load-gated)", () => {
  const pages = [
    "https://img.example/7/1.jpg",
    "https://img.example/7/2.jpg",
    "https://img.example/7/3.jpg",
  ]

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  const activate = () =>
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

  // During a slide there are two imgs: the outgoing underlay first,
  // the shown (incoming) page last.
  const imgs = (container: HTMLElement) => Array.from(container.querySelectorAll("img"))
  const shownImg = (container: HTMLElement) => imgs(container).at(-1)!
  const shownWrapper = (container: HTMLElement) => shownImg(container).parentElement!

  beforeEach(() => {
    mockWaitForImage.mockReset()
    mockWaitForImage.mockResolvedValue(undefined)
    vi.mocked(fetchSaucePages).mockResolvedValue(pages)
  })

  it("holds the current page until the incoming image is paintable, then slides it in", async () => {
    const load = deferred<void>()
    mockWaitForImage.mockReturnValue(load.promise)
    const { container } = renderCard(longTitle)
    activate()

    // Initial render: first image, no animation armed.
    expect(shownImg(container).getAttribute("src")).toBe(longTitle.firstImageUrl)
    expect(shownWrapper(container).className).not.toContain("page-anim-")

    // Next click: the pager targets page 2, but while its image is
    // still loading the shown page stays page 1 — no swap, no slide
    // over an unpainted frame.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    expect(imgs(container)).toHaveLength(1)
    expect(shownImg(container).getAttribute("src")).toBe(pages[0])
    expect(shownWrapper(container).className).not.toContain("page-anim-")

    // Load lands: page 2 commits WITH the slide, over page 1.
    await act(async () => {
      load.resolve()
    })
    expect(shownImg(container).getAttribute("src")).toBe(pages[1])
    expect(shownWrapper(container).className).toContain("page-anim-next")

    // Mirror for Prev: held while loading, then page-anim-prev.
    const loadBack = deferred<void>()
    mockWaitForImage.mockReturnValue(loadBack.promise)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    })
    expect(shownImg(container).getAttribute("src")).toBe(pages[1])
    await act(async () => {
      loadBack.resolve()
    })
    expect(shownImg(container).getAttribute("src")).toBe(pages[0])
    expect(shownWrapper(container).className).toContain("page-anim-prev")
  })

  it("commits only the latest target when turns come faster than loads", async () => {
    const loads: ReturnType<typeof deferred<void>>[] = []
    mockWaitForImage.mockImplementation(() => {
      const d = deferred<void>()
      loads.push(d)
      return d.promise
    })
    const { container } = renderCard(longTitle)
    activate()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    expect(loads).toHaveLength(2)
    expect(shownImg(container).getAttribute("src")).toBe(pages[0])

    // The superseded page-2 load resolves late: commits nothing.
    await act(async () => {
      loads[0].resolve()
    })
    expect(shownImg(container).getAttribute("src")).toBe(pages[0])
    expect(imgs(container)).toHaveLength(1)

    // The latest target (page 3) commits when its load lands.
    await act(async () => {
      loads[1].resolve()
    })
    expect(shownImg(container).getAttribute("src")).toBe(pages[2])
    expect(shownWrapper(container).className).toContain("page-anim-next")
  })

  it("swaps immediately, ungated and unanimated, when the page list replaces the first-image src", async () => {
    // Same pages, different CDN host string than firstImageUrl:
    // the page-list load changes the src at pageIdx 0 with no turn
    // direction, so it must not wait on the gate.
    const altPages = [
      "https://cdn-other.example/7/1.jpg",
      "https://cdn-other.example/7/2.jpg",
    ]
    vi.mocked(fetchSaucePages).mockResolvedValue(altPages)
    mockWaitForImage.mockReturnValue(new Promise<void>(() => {}))
    const { container } = renderCard(longTitle)
    activate()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    // The dir-0 swap to the list's page 1 already happened, even
    // though the (directed) page-2 gate never resolves.
    expect(shownImg(container).getAttribute("src")).toBe(altPages[0])
    expect(shownWrapper(container).className).not.toContain("page-anim-")
    expect(mockWaitForImage).toHaveBeenCalledWith(altPages[1])
    expect(imgs(container)).toHaveLength(1)
  })

  it("keeps the outgoing page underneath during the slide and removes it on animationend", async () => {
    const { container } = renderCard(longTitle)
    activate()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    const all = imgs(container)
    expect(all).toHaveLength(2)
    expect(all[0].getAttribute("src")).toBe(pages[0]) // underlay: outgoing
    expect(all[1].getAttribute("src")).toBe(pages[1]) // shown: incoming

    fireEvent.animationEnd(shownWrapper(container))
    expect(imgs(container)).toHaveLength(1)
    expect(shownImg(container).getAttribute("src")).toBe(pages[1])
  })

  it("removes the underlay on the fallback timeout when no animationend fires", async () => {
    vi.useFakeTimers()
    try {
      const { container } = renderCard(longTitle)
      activate()
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Next page" }))
      })
      expect(imgs(container)).toHaveLength(2)

      // Reduced-motion case: animation is none, animationend never
      // fires — the timeout clear is what removes the underlay.
      await act(async () => {
        vi.advanceTimersByTime(400)
      })
      expect(imgs(container)).toHaveLength(1)
      expect(shownImg(container).getAttribute("src")).toBe(pages[1])
    } finally {
      vi.useRealTimers()
    }
  })

  it("still commits the turn when the image wait fails", async () => {
    mockWaitForImage.mockRejectedValue(new Error("decode failed"))
    const { container } = renderCard(longTitle)
    activate()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    expect(shownImg(container).getAttribute("src")).toBe(pages[1])
    expect(shownWrapper(container).className).toContain("page-anim-next")
  })
})

describe("SauceCard image error state", () => {
  beforeEach(() => {
    mockWaitForImage.mockReset()
    mockWaitForImage.mockResolvedValue(undefined)
    vi.mocked(fetchSaucePages).mockResolvedValue([
      "https://img.example/7/1.jpg",
      "https://img.example/7/2.jpg",
      "https://img.example/7/3.jpg",
    ])
  })

  it("shows a retry panel when the shown image fails, and retry remounts the img", () => {
    const { container } = renderCard(longTitle)
    expect(screen.queryByText("This page didn't load.")).toBeNull()

    const img = container.querySelector("img")!
    fireEvent.error(img)
    expect(screen.getByText("This page didn't load.")).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Retry loading this page" }))
    expect(screen.queryByText("This page didn't load.")).toBeNull()
    // A fresh img element for the same page: the remount is what
    // re-requests an errored resource.
    const remounted = container.querySelector("img")!
    expect(remounted).not.toBe(img)
    expect(remounted.getAttribute("src")).toBe(longTitle.firstImageUrl)

    // If it fails again, the panel comes back.
    fireEvent.error(remounted)
    expect(screen.getByText("This page didn't load.")).not.toBeNull()
  })

  it("clears the error state when the page changes", async () => {
    const { container } = renderCard(longTitle)
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })
    fireEvent.error(container.querySelector("img")!)
    expect(screen.getByText("This page didn't load.")).not.toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    expect(screen.queryByText("This page didn't load.")).toBeNull()
  })
})

describe("SauceCard page live region and arrow boundaries", () => {
  const threePages = [
    "https://img.example/7/1.jpg",
    "https://img.example/7/2.jpg",
    "https://img.example/7/3.jpg",
  ]
  const threePager: Sauce = { ...longTitle, pageCount: 3 }

  beforeEach(() => {
    mockWaitForImage.mockReset()
    mockWaitForImage.mockResolvedValue(undefined)
    vi.mocked(fetchSaucePages).mockResolvedValue(threePages)
  })

  const activate = () =>
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

  it("announces the page position on the active card as pages turn", async () => {
    const { container } = renderCard(threePager)
    const region = container.querySelector("[role='status']")!
    // Inactive cards stay silent.
    expect(region.textContent).toBe("")

    activate()
    expect(region.textContent).toBe("Page 1 of 3")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    expect(region.textContent).toBe("Page 2 of 3")
  })

  it("disables Prev on the first page and Next on the last page", async () => {
    renderCard(threePager)
    activate()
    const prev = screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement
    const next = screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement
    expect(prev.disabled).toBe(true)
    expect(next.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(next)
    })
    await act(async () => {
      fireEvent.click(next)
    })
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(true)
  })
})

describe("SauceCard strip (webtoon) pages", () => {
  // Sanitised fixture mirroring gallery 491558's shape: a normal
  // opening page (300×420), one genuine strip file (720×16001 —
  // the real gallery's page 4, measured), then a normal page
  // again (1280×1807). Classification is per page, so the modes
  // must flip as the user pages. Sizes arrive via the
  // loadImageMeta mock, scripted per src.
  const stripPages = [
    "https://img.example/491558/1.jpg",
    "https://img.example/491558/2.jpg",
    "https://img.example/491558/3.jpg",
  ]
  const metaBySrc: Record<string, { width: number; height: number }> = {
    [stripPages[0]]: { width: 300, height: 420 },
    [stripPages[1]]: { width: 720, height: 16001 },
    [stripPages[2]]: { width: 1280, height: 1807 },
  }
  const stripSauce: Sauce = {
    id: 491558,
    title: "Strip Fixture Gallery",
    url: "https://nhentai.net/g/491558/",
    firstImageUrl: stripPages[0],
    pageCount: 3,
  }

  const activate = () =>
    act(() => {
      IntersectionObserverStub.latest().trigger([
        { isIntersecting: true, intersectionRatio: 1 },
      ])
    })

  beforeEach(() => {
    mockWaitForImage.mockReset()
    mockWaitForImage.mockResolvedValue(undefined)
    vi.mocked(fetchSaucePages).mockResolvedValue(stripPages)
    mockLoadImageMeta.mockReset()
    mockLoadImageMeta.mockImplementation((src) =>
      Promise.resolve(metaBySrc[src] ?? null),
    )
  })

  afterEach(() => {
    // Leave the shared mock at its file-wide default for the
    // other suites: unknown size → normal page.
    mockLoadImageMeta.mockReset()
    mockLoadImageMeta.mockResolvedValue(null)
  })

  it("renders normal pages as today and strip pages width-full in the in-card scroller, flipping per page", async () => {
    const onToggleBlur = vi.fn()
    const { container } = render(
      <SauceCard
        sauce={stripSauce}
        blurred={true}
        onToggleBlur={onToggleBlur}
        dimmed={false}
        onToggleDim={() => {}}
      />,
    )
    activate()
    await act(async () => {})
    const region = container.querySelector("[role='status']")!
    // During a slide there are two imgs: outgoing underlay first,
    // shown page last.
    const shownImg = () => Array.from(container.querySelectorAll("img")).at(-1)!

    // Page 1 (normal): fit-to-screen exactly as today, the tap
    // layer is the full-screen <button>, no strip scroller.
    expect(region.textContent).toBe("Page 1 of 3")
    expect(shownImg().getAttribute("src")).toBe(stripPages[0])
    expect(shownImg().className).toContain("object-contain")
    expect(container.querySelector(".strip-scroll")).toBeNull()
    expect(screen.getByRole("button", { name: "Reveal image" }).tagName).toBe("BUTTON")

    // Page 2 (the strip): width-full inside .strip-scroll, no
    // object-contain; the caption still counts it as page 2.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    })
    expect(region.textContent).toBe("Page 2 of 3")
    const scroller = container.querySelector(".strip-scroll")
    expect(scroller).not.toBeNull()
    expect(scroller!.className).toContain("overflow-y-auto")
    const stripImg = scroller!.querySelector("img")!
    expect(stripImg.getAttribute("src")).toBe(stripPages[1])
    expect(stripImg.className).toContain("w-full")
    expect(stripImg.className).toContain("h-auto")
    expect(stripImg.className).not.toContain("object-contain")

    // The gesture surface is the scroller itself (a div — a
    // <button> cannot wrap a scrolling region): tapping it
    // toggles blur, and Enter on it does too (hand-wired
    // activation parity with the button it replaces).
    const surface = screen.getByRole("button", { name: "Reveal image" })
    expect(surface).toBe(scroller)
    expect(surface.tagName).toBe("DIV")
    fireEvent.click(surface)
    expect(onToggleBlur).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(surface, { key: "Enter" })
    expect(onToggleBlur).toHaveBeenCalledTimes(2)

    // A horizontal swipe on the strip surface still turns the page.
    const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true }
    fireEvent.pointerDown(surface, { ...pointer, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(surface, { ...pointer, clientX: 150, clientY: 101 })
    fireEvent.pointerUp(surface, { ...pointer, clientX: 130, clientY: 101 })
    await act(async () => {})

    // Page 3 is normal again: per-page classification — the
    // scroller is gone, contain rendering and the <button> tap
    // layer are restored.
    expect(region.textContent).toBe("Page 3 of 3")
    expect(container.querySelector(".strip-scroll")).toBeNull()
    expect(shownImg().getAttribute("src")).toBe(stripPages[2])
    expect(shownImg().className).toContain("object-contain")
    expect(screen.getByRole("button", { name: "Reveal image" }).tagName).toBe("BUTTON")
  })
})
