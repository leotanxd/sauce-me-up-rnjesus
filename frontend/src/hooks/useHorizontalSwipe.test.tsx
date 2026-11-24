import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useHorizontalSwipe } from "./useHorizontalSwipe"

let suppressClickRef!: { current: boolean }

function Harness({
  enabled = true,
  onSwipe,
}: {
  enabled?: boolean
  onSwipe: (delta: 1 | -1) => void
}) {
  const swipe = useHorizontalSwipe({ enabled, onSwipe })
  suppressClickRef = swipe.suppressClickRef
  return (
    <div
      data-testid="surface"
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
    />
  )
}

afterEach(() => {
  cleanup()
})

const pointer = { pointerId: 1, pointerType: "touch", isPrimary: true }

function swipeGesture(
  el: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  fireEvent.pointerDown(el, { ...pointer, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(el, {
    ...pointer,
    clientX: (from.x + to.x) / 2,
    clientY: (from.y + to.y) / 2,
  })
  fireEvent.pointerUp(el, { ...pointer, clientX: to.x, clientY: to.y })
}

describe("useHorizontalSwipe", () => {
  it("fires onSwipe(1) once for a left swipe past the threshold", () => {
    const onSwipe = vi.fn()
    render(<Harness onSwipe={onSwipe} />)
    swipeGesture(screen.getByTestId("surface"), { x: 200, y: 100 }, { x: 120, y: 103 })
    expect(onSwipe).toHaveBeenCalledTimes(1)
    expect(onSwipe).toHaveBeenCalledWith(1)
    expect(suppressClickRef.current).toBe(true)
  })

  it("fires onSwipe(-1) for a right swipe", () => {
    const onSwipe = vi.fn()
    render(<Harness onSwipe={onSwipe} />)
    swipeGesture(screen.getByTestId("surface"), { x: 100, y: 100 }, { x: 190, y: 98 })
    expect(onSwipe).toHaveBeenCalledTimes(1)
    expect(onSwipe).toHaveBeenCalledWith(-1)
    expect(suppressClickRef.current).toBe(true)
  })

  it("fires nothing and does not suppress the click for a 30px movement", () => {
    const onSwipe = vi.fn()
    render(<Harness onSwipe={onSwipe} />)
    swipeGesture(screen.getByTestId("surface"), { x: 200, y: 100 }, { x: 170, y: 101 })
    expect(onSwipe).not.toHaveBeenCalled()
    expect(suppressClickRef.current).toBe(false)
  })

  it("fires nothing for a vertical-dominant gesture", () => {
    const onSwipe = vi.fn()
    render(<Harness onSwipe={onSwipe} />)
    swipeGesture(screen.getByTestId("surface"), { x: 200, y: 100 }, { x: 205, y: 220 })
    expect(onSwipe).not.toHaveBeenCalled()
    expect(suppressClickRef.current).toBe(false)
  })

  it("fires nothing when pointercancel aborts the gesture", () => {
    const onSwipe = vi.fn()
    render(<Harness onSwipe={onSwipe} />)
    const el = screen.getByTestId("surface")
    fireEvent.pointerDown(el, { ...pointer, clientX: 200, clientY: 100 })
    fireEvent.pointerMove(el, { ...pointer, clientX: 150, clientY: 101 })
    fireEvent.pointerCancel(el, { ...pointer, clientX: 130, clientY: 101 })
    fireEvent.pointerUp(el, { ...pointer, clientX: 120, clientY: 101 })
    expect(onSwipe).not.toHaveBeenCalled()
    expect(suppressClickRef.current).toBe(false)
  })

  it("ignores everything when disabled", () => {
    const onSwipe = vi.fn()
    render(<Harness enabled={false} onSwipe={onSwipe} />)
    swipeGesture(screen.getByTestId("surface"), { x: 200, y: 100 }, { x: 100, y: 100 })
    expect(onSwipe).not.toHaveBeenCalled()
    expect(suppressClickRef.current).toBe(false)
  })

  it("fires nothing for a press-and-release with no movement", () => {
    const onSwipe = vi.fn()
    render(<Harness onSwipe={onSwipe} />)
    const el = screen.getByTestId("surface")
    fireEvent.pointerDown(el, { ...pointer, clientX: 200, clientY: 100 })
    fireEvent.pointerUp(el, { ...pointer, clientX: 200, clientY: 100 })
    expect(onSwipe).not.toHaveBeenCalled()
    expect(suppressClickRef.current).toBe(false)
  })
})
