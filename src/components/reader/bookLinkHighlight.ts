import { subscribe } from 'valtio/vanilla'

import type { BookTab } from '../../models/reader'
import { getElementByIdOrName } from '../../noteIndex'
import { sameHref } from '../../noteLinks'

import { intersectRects, type RectLike } from './noteGeometry'

function targetGeometry(tab: BookTab, target: string, container: HTMLElement, layer: HTMLElement) {
  const hash = target.indexOf('#')
  if (hash < 0 || hash === target.length - 1) return
  const path = target.slice(0, hash)
  const id = target.slice(hash + 1)
  const view = tab.rendition?.session.getDisplayedViews().find((view) => sameHref(view.section.href, path))
  const frame = view?.window?.frameElement as HTMLIFrameElement | null | undefined
  const doc = frame?.contentDocument
  const win = doc?.defaultView
  if (!view || !frame || !doc || !win) return
  const anchor = getElementByIdOrName(doc, id)
  if (!anchor || anchor === doc.body || anchor === doc.documentElement) return
  const style = win.getComputedStyle(anchor)
  if (style.visibility !== 'visible' || style.display === 'none') return
  const frameRect = frame.getBoundingClientRect()
  const layerRect = layer.getBoundingClientRect()
  // The view clips its off-page columns; the iframe itself can span a chapter.
  const viewport = intersectRects(container.getBoundingClientRect(), view.element.getBoundingClientRect())
  const clip = viewport && intersectRects(viewport, frameRect)
  if (!clip || !frame.clientWidth || !frame.clientHeight) return
  const scaleX = frameRect.width / frame.clientWidth
  const scaleY = frameRect.height / frame.clientHeight
  const rects: RectLike[] = []
  for (const rect of anchor.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const visible = intersectRects(clip, {
      left: frameRect.left + rect.left * scaleX,
      top: frameRect.top + rect.top * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    })
    if (!visible) continue
    rects.push({ ...visible, left: visible.left - layerRect.left, top: visible.top - layerRect.top })
  }
  return rects.length ? rects : undefined
}

/** Owns only application-layer paint; it never writes to the EPUB document. */
export function createBookLinkHighlight(tab: BookTab, container: HTMLElement, layer: HTMLElement) {
  let revision = 0
  let frame: number | undefined
  let cleanup: (() => void) | undefined

  const clear = () => {
    revision++
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    cleanup?.()
    cleanup = undefined
    layer.replaceChildren()
  }

  return {
    clear,
    begin() {
      clear()
      const request = revision
      return (target: string) => {
        if (request !== revision || !tab.active || !tab.rendered || tab.turning || !target.includes('#')) return
        const { layoutVersion, paginationVersion, renderGeneration } = tab
        const isCurrent = () =>
          request === revision &&
          tab.active &&
          tab.rendered &&
          !tab.turning &&
          tab.layoutVersion === layoutVersion &&
          tab.paginationVersion === paginationVersion &&
          tab.renderGeneration === renderGeneration
        const unsubscribe = subscribe(
          tab,
          () => {
            if (!isCurrent()) clear()
          },
          true,
        )
        cleanup = unsubscribe
        // One paint boundary lets the committed reader uncover its body. This is
        // not a layout retry: any intervening navigation invalidates the hint.
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (!isCurrent()) {
            clear()
            return
          }
          const geometry = targetGeometry(tab, target, container, layer)
          if (!geometry) {
            clear()
            return
          }
          const fragment = layer.ownerDocument.createDocumentFragment()
          for (const rect of geometry) {
            const hint = layer.ownerDocument.createElement('div')
            hint.dataset.flowLinkTarget = ''
            Object.assign(hint.style, {
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            })
            fragment.append(hint)
          }
          const events = new AbortController()
          const documents = [layer.ownerDocument, ...tab.iframes.map((win) => win.document)]
          const onImageLoad = (event: Event) => {
            if ((event.target as Element | null)?.localName === 'img') clear()
          }
          for (const doc of documents) {
            doc.addEventListener('scroll', clear, { capture: true, signal: events.signal })
            doc.addEventListener('load', onImageLoad, { capture: true, signal: events.signal })
          }
          layer.ownerDocument.addEventListener('visibilitychange', clear, { signal: events.signal })
          layer.addEventListener('animationend', clear, { signal: events.signal })
          cleanup = () => {
            unsubscribe()
            events.abort()
          }
          layer.append(fragment)
        })
      }
    },
    dispose: clear,
  }
}
