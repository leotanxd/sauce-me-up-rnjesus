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
