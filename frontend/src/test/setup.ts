/**
 * Test-environment stubs for browser APIs jsdom lacks.
 *
 * IntersectionObserver: jsdom has none. The stub records every
 * instance so tests can fire entries manually via `ioInstances`.
 */
export class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []

  readonly callback: IntersectionObserverCallback
  readonly elements = new Set<Element>()

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    IntersectionObserverStub.instances.push(this)
  }

  observe(el: Element): void {
    this.elements.add(el)
  }

  unobserve(el: Element): void {
    this.elements.delete(el)
  }

  disconnect(): void {
    this.elements.clear()
  }

  /** Fire entries at this observer, as the browser would. */
  trigger(entries: Partial<IntersectionObserverEntry>[]): void {
    this.callback(
      entries as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    )
  }

  static reset(): void {
    IntersectionObserverStub.instances.length = 0
  }

  static latest(): IntersectionObserverStub {
    const instance = IntersectionObserverStub.instances.at(-1)
    if (!instance) throw new Error("no IntersectionObserver was created")
    return instance
  }
}

export const ioInstances = IntersectionObserverStub.instances

globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver

// jsdom leaves scrolling unimplemented; the hooks call these on refs.
window.scrollTo = () => {}
window.scrollBy = () => {}
Element.prototype.scrollTo = () => {}
Element.prototype.scrollBy = () => {}

// jsdom has no PointerEvent: fireEvent would build a plain Event
// and React's synthetic pointer events would carry no clientX /
// pointerId / pointerType. This stub extends MouseEvent (so the
// mouse fields work) and adds the pointer fields. setPointerCapture
// stays absent — the swipe hook feature-detects it, as in browsers
// that lack it.
class PointerEventStub extends MouseEvent {
  readonly pointerId: number
  readonly pointerType: string
  readonly isPrimary: boolean

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.pointerType = init.pointerType ?? ""
    this.isPrimary = init.isPrimary ?? false
  }
}
globalThis.PointerEvent = PointerEventStub as typeof PointerEvent

// jsdom has no matchMedia. The stub defaults to "not small"
// (desktop) so existing tests are unaffected; component tests flip
// it with setSmallScreen() BEFORE rendering.
let smallScreen = false
export function setSmallScreen(value: boolean): void {
  smallScreen = value
}
window.matchMedia = (query: string): MediaQueryList =>
  ({
    matches: query.includes("max-width") ? smallScreen : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
