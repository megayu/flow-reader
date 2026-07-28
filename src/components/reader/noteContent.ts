import type { BookTab, ISection } from '../../models/reader'
import { findReciprocalNoteItem } from '../../noteIndex'
import { findSectionByLinkedHref, safeDecodeHref, sameHref } from '../../noteLinks'
import { isNoteMarkerText } from '../../noteSemantics'

import { getVisiblePageRect, intersectRects, type RectLike, rectFromDomRect } from './noteGeometry'

export type { RectLike } from './noteGeometry'

export interface NotePopoverState {
  anchorRect: RectLike
  pageRect: RectLike
  content: HTMLElement
  writingMode: string
}

export interface NotePopoverTypography {
  fontSize?: string
  lineHeight?: number
}

const NOTE_POPOVER_TEXT_STYLE_PROPERTIES = [
  'direction',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-size',
  'font-stretch',
  'font-style',
  'font-synthesis',
  'font-variant',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-emphasis-color',
  'text-emphasis-position',
  'text-emphasis-style',
  'text-orientation',
  'text-transform',
  'unicode-bidi',
  'vertical-align',
  'word-spacing',
  'writing-mode',
]
export function createNotePopoverState(
  anchor: HTMLAnchorElement,
  noteElement: HTMLElement,
  container: HTMLElement | null,
  rendition: unknown,
  typography?: NotePopoverTypography,
): NotePopoverState | undefined {
  const win = anchor.ownerDocument.defaultView
  const frame = win?.frameElement
  if (!win || !(frame instanceof HTMLElement) || !container) return

  const containerRect = container.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const anchorRectInContainer = rectFromDomRect({
    left: frameRect.left + anchorRect.left - containerRect.left,
    top: frameRect.top + anchorRect.top - containerRect.top,
    width: anchorRect.width,
    height: anchorRect.height,
  })
  const visibleRect = intersectRects(
    {
      left: frameRect.left - containerRect.left,
      top: frameRect.top - containerRect.top,
      width: frameRect.width,
      height: frameRect.height,
    },
    {
      left: 0,
      top: 0,
      width: containerRect.width,
      height: containerRect.height,
    },
  )

  if (!visibleRect) return

  const writingMode = win.getComputedStyle(anchor).writingMode

  return {
    anchorRect: anchorRectInContainer,
    pageRect: getVisiblePageRect(visibleRect, anchorRectInContainer, rendition),
    content: cloneNoteElement(noteElement, anchor, typography, writingMode),
    writingMode,
  }
}

export function getAnchorFromEvent(e: MouseEvent) {
  const direct = (e.target as ClosestTarget | null)?.closest?.('a[href]') as HTMLAnchorElement | undefined
  if (direct) return direct

  return e
    .composedPath()
    .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement && node.hasAttribute('href'))
}

export function getBookLinkDisplayTarget(tab: BookTab, anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')?.trim()
  if (!href || isExternalBookLinkHref(href)) return

  const [path = '', hash = ''] = href.split('#')
  if (!path && !hash) return

  const anchorSection = findRenderedSectionByDocument(tab, anchor.ownerDocument) ?? tab.section
  const targetSection = path ? findSectionByLinkedHref(tab.sections, anchorSection?.href, path) : anchorSection
  if (!targetSection?.href) return

  return hash ? `${targetSection.href}#${safeDecodeHref(hash)}` : targetSection.href
}

function isExternalBookLinkHref(href: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
}

interface ClosestTarget {
  closest?: (selector: string) => Element | null
}

export interface LinkedNoteResult {
  element: HTMLElement
  cleanup?: () => void
}

export async function getLinkedNote(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  container: HTMLElement | null,
): Promise<LinkedNoteResult | undefined> {
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('mailto:') || href.includes('://')) return

  const [path = '', hash = ''] = href.split('#')
  if (!hash) return

  const id = safeDecodeHref(hash)
  const target = await findLinkedElement(tab, anchor, path, id, container)
  const noteItem = target && findReciprocalNoteItem(anchor, target.element)
  if (!target || !noteItem) {
    target?.cleanup?.()
    return
  }

  const noteElement = findNoteElement(noteItem, anchor)
  return noteElement
    ? {
        element: noteElement,
        cleanup: target.cleanup,
      }
    : target
}

async function findLinkedElement(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  path: string,
  id: string,
  container: HTMLElement | null,
): Promise<LinkedNoteResult | undefined> {
  const currentDocument = anchor.ownerDocument

  if (!path) {
    return wrapNoteElement(getElementByIdOrName(currentDocument, id))
  }

  const anchorSection = findRenderedSectionByDocument(tab, currentDocument)
  const baseHref = anchorSection?.href ?? tab.section?.href
  const targetSection = findSectionByLinkedHref(tab.sections, baseHref, path)

  if (targetSection && sameHref(anchorSection?.href, targetSection.href)) {
    const currentElement = getElementByIdOrName(currentDocument, id)
    if (currentElement) return wrapNoteElement(currentElement)
  }

  if (targetSection) {
    const renderedDocument = findRenderedDocumentBySection(tab, targetSection)
    const renderedElement = renderedDocument && getElementByIdOrName(renderedDocument, id)
    if (renderedElement) return wrapNoteElement(renderedElement)

    return renderLinkedSectionElement(tab, anchor, targetSection, id, container)
  }

  return wrapNoteElement(getElementByIdOrName(currentDocument, id))
}

function wrapNoteElement(element: HTMLElement | undefined): LinkedNoteResult | undefined {
  return element ? { element } : undefined
}

function getElementByIdOrName(doc: Document, id: string) {
  return (
    doc.getElementById(id) ??
    ([...doc.querySelectorAll('[name]')].find((el) => el.getAttribute('name') === id) as HTMLElement | undefined)
  )
}

function findRenderedSectionByDocument(tab: BookTab, doc: Document) {
  const canonical = getDocumentCanonicalHref(doc)

  return tab.sections?.find((section) => sameHref(section.href, canonical) || sameHref(section.canonical, canonical))
}

function findRenderedDocumentBySection(tab: BookTab, section: ISection) {
  const windows = tab.iframes.length ? tab.iframes : tab.iframe ? [tab.iframe] : []

  return windows
    .map((win) => win.document)
    .find((doc) => {
      const canonical = getDocumentCanonicalHref(doc)

      return sameHref(section.href, canonical) || sameHref(section.canonical, canonical)
    })
}

function getDocumentCanonicalHref(doc: Document) {
  return doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href') ?? undefined
}

async function renderLinkedSectionElement(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  section: ISection,
  id: string,
  container: HTMLElement | null,
): Promise<LinkedNoteResult | undefined> {
  if (!tab.epub || !container) return

  const ownerDocument = container.ownerDocument
  const iframe = ownerDocument.createElement('iframe')
  const sourceFrame = anchor.ownerDocument.defaultView?.frameElement
  const sourceFrameRect = sourceFrame instanceof HTMLElement ? sourceFrame.getBoundingClientRect() : undefined
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.tabIndex = -1
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: `${Math.max(320, Math.ceil(sourceFrameRect?.width ?? 960))}px`,
    height: `${Math.max(320, Math.ceil(sourceFrameRect?.height ?? 960))}px`,
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  })

  const cleanup = () => iframe.remove()

  try {
    const output = stripScriptsFromNoteSectionHtml(await renderFreshLinkedSectionDocument(tab, section, id))
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 1500)

      iframe.addEventListener(
        'load',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      iframe.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer)
          reject(new Error(`Failed to render note section: ${section.href}`))
        },
        { once: true },
      )
    })

    iframe.srcdoc = output
    container.appendChild(iframe)
    await loaded

    const doc = iframe.contentDocument
    if (!doc) {
      cleanup()
      return
    }

    await waitForNoteDocumentStyles(doc)
    const target = getElementByIdOrName(doc, id)
    if (!target) {
      cleanup()
      return
    }

    return { element: target, cleanup }
  } catch (_error) {
    cleanup()
    return
  }
}

async function renderFreshLinkedSectionDocument(tab: BookTab, section: ISection, id: string) {
  const sectionUrl = section.url
  if (!sectionUrl) {
    throw new Error(`Missing section url: ${section.href}`)
  }

  const document = (await tab.epub!.load(sectionUrl)) as Document

  await section.hooks?.content?.trigger(document, section)

  const target = getElementByIdOrName(document, id)
  if (!target) {
    throw new Error(`Missing linked note target: ${section.href}#${id}`)
  }

  return document.documentElement.outerHTML
}

async function waitForNoteDocumentStyles(doc: Document) {
  const fonts = doc.fonts
  if (fonts) {
    await Promise.race([fonts.ready.catch(() => undefined), new Promise((resolve) => window.setTimeout(resolve, 300))])
  }

  await new Promise((resolve) => window.requestAnimationFrame(resolve))
}

export function isInternalBookHashLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('mailto:') || href.includes('://')) return false

  const [, hash = ''] = href.split('#')
  return !!hash
}

function stripScriptsFromNoteSectionHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '')
}

function findNoteElement(el: HTMLElement, anchor: HTMLAnchorElement) {
  const segmentedNote = createSegmentedNoteElement(el, anchor)
  if (segmentedNote) return segmentedNote

  const regularNote = findRegularNoteElement(el)
  if (hasUsefulNoteElementContent(regularNote)) return regularNote

  return regularNote ?? el
}

function findRegularNoteElement(el: HTMLElement) {
  let cur: HTMLElement | null = el
  let fallback: HTMLElement | undefined

  while (cur && cur !== cur.ownerDocument.body) {
    if (isNoteContainer(cur)) {
      return cur
    }

    if (!fallback && isTagName(cur, 'P', 'LI', 'BLOCKQUOTE', 'DIV', 'TABLE')) {
      fallback = cur
    }

    cur = cur.parentElement
  }

  return fallback ?? el
}

function hasUsefulNoteElementContent(el: HTMLElement | undefined) {
  if (!el || isEmptyPositionTarget(el)) return false

  const text = el.textContent?.trim() ?? ''
  if (text && !isNoteMarkerText(text)) return true

  return !!el.querySelector('img, svg, math')
}

function isEmptyPositionTarget(el: HTMLElement) {
  return isTagName(el, 'A', 'SPAN') && !!(el.id || el.getAttribute('name')) && !el.textContent?.trim()
}

function createSegmentedNoteElement(target: HTMLElement, anchor: HTMLAnchorElement) {
  const container = findNoteContainer(target)
  const marker = target.closest('a[href]') as HTMLAnchorElement | null
  if (!container || !marker || !isBacklink(marker, anchor)) return

  const markerChild = getDirectChild(container, marker)
  if (!markerChild || !hasMultipleNoteMarkers(container)) return

  const doc = target.ownerDocument
  const wrapper = doc.createElement('div')

  wrapper.className = container.className
  if (container.id) wrapper.dataset.noteContainerId = container.id
  copyNoteTextStyles(container, wrapper)

  let node: ChildNode | null = markerChild
  while (node) {
    if (node !== markerChild && startsWithNoteMarker(node)) break

    wrapper.appendChild(cloneNoteNode(node))
    node = node.nextSibling
  }

  return wrapper.childNodes.length ? wrapper : undefined
}

function cloneNoteNode(node: ChildNode) {
  if (isElementNode(node)) {
    return cloneElementWithNoteStyles(node as HTMLElement)
  }

  return node.cloneNode(true)
}

function getDirectChild(parent: HTMLElement, child: HTMLElement) {
  let cur: HTMLElement = child

  while (cur.parentElement && cur.parentElement !== parent) {
    cur = cur.parentElement
  }

  return cur.parentElement === parent ? cur : undefined
}

function hasMultipleNoteMarkers(container: HTMLElement) {
  return Array.from(container.childNodes).filter(startsWithNoteMarker).length > 1
}

function startsWithNoteMarker(node: ChildNode) {
  if (!isElementNode(node)) return false
  const el = node as HTMLElement

  if (isNoteMarkerAnchor(el)) return true

  const firstElement = Array.from(el.childNodes).find(
    (child) => isElementNode(child) || (child.textContent?.trim()?.length ?? 0) > 0,
  )

  return isElementNode(firstElement) && isNoteMarkerAnchor(firstElement as HTMLElement)
}

function isNoteMarkerAnchor(el: HTMLElement) {
  return isTagName(el, 'A') && el.hasAttribute('href') && isNoteMarkerText(el.textContent)
}

function isElementNode(node: ChildNode | undefined) {
  return node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
}

function findNoteContainer(el: HTMLElement) {
  let cur: HTMLElement | null = el

  while (cur && cur !== cur.ownerDocument.body) {
    if (isNoteContainer(cur)) return cur
    cur = cur.parentElement
  }
}

function isNoteContainer(el: HTMLElement) {
  if (isInlineNoteMarker(el)) return false

  return isTagName(el, 'ASIDE') || hasStandardNoteSemantics(el)
}

function isInlineNoteMarker(el: HTMLElement) {
  return isTagName(el, 'A', 'SPAN', 'SUP', 'SUB') && isNoteMarkerText(el.textContent)
}

function isTagName(el: Element, ...names: string[]) {
  const tagName = el.tagName.toUpperCase()
  return names.some((name) => tagName === name)
}

function hasStandardNoteSemantics(el: HTMLElement) {
  const role = el.getAttribute('role')
  if (hasToken(role, 'doc-footnote', 'doc-endnote', 'doc-note', 'note')) {
    return true
  }

  return hasToken(el.getAttribute('epub:type') ?? el.getAttribute('type'), 'footnote', 'endnote', 'rearnote', 'note')
}

function hasToken(value: string | null | undefined, ...tokens: string[]) {
  if (!value) return false

  const normalized = value.toLowerCase().split(/\s+/)
  return tokens.some((token) => normalized.includes(token))
}

function cloneNoteElement(
  el: HTMLElement,
  anchor: HTMLAnchorElement,
  typography?: NotePopoverTypography,
  writingMode?: string,
) {
  const clone = cloneNoteContentElement(el)

  clone.querySelectorAll('script, style').forEach((node) => node.remove())
  clone.querySelectorAll('a[href]').forEach((node) => {
    if (isBacklink(node as HTMLAnchorElement, anchor)) {
      unwrapBacklink(node as HTMLAnchorElement)
    }
  })
  normalizeNotePopoverContent(clone)
  applyNotePopoverTypography(clone, typography)
  applyNotePopoverWritingMode(clone, writingMode)

  return clone
}

function applyNotePopoverWritingMode(root: HTMLElement, writingMode?: string) {
  if (writingMode !== 'vertical-rl') return

  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
  nodes.forEach((node) => {
    node.style.setProperty('writing-mode', 'vertical-rl', 'important')
    node.style.setProperty('text-orientation', 'mixed', 'important')
  })
}

function applyNotePopoverTypography(root: HTMLElement, typography?: NotePopoverTypography) {
  if (!typography?.fontSize && typography?.lineHeight === undefined) return

  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
  nodes.forEach((node) => {
    if (typography.fontSize) {
      node.style.setProperty('font-size', typography.fontSize, 'important')
    }
    if (typography.lineHeight !== undefined) {
      node.style.setProperty('line-height', String(typography.lineHeight), 'important')
    } else if (typography.fontSize) {
      node.style.setProperty('line-height', 'normal', 'important')
    }
  })
}

function cloneNoteContentElement(el: HTMLElement) {
  const source = getFlattenedNoteContentSource(el)
  if (!shouldFlattenNoteRoot(source)) {
    return cloneElementWithNoteStyles(source)
  }

  const wrapper = source.ownerDocument.createElement('div')
  copyNoteTextStyles(source, wrapper)
  Array.from(source.childNodes).forEach((node) => {
    wrapper.appendChild(cloneNoteNode(node))
  })

  return wrapper
}

function getFlattenedNoteContentSource(el: HTMLElement) {
  let current = el
  let child = getFlattenableNoteChild(current)

  while (child) {
    current = child
    child = getFlattenableNoteChild(current)
  }

  return current
}

function getFlattenableNoteChild(el: HTMLElement) {
  const child = getSingleElementChild(el)
  if (!child || hasMeaningfulOwnText(el)) return

  if (isTagName(el, 'LI') && isTagName(child, 'P', 'DIV', 'BLOCKQUOTE')) {
    return child
  }

  if (isTagName(el, 'P', 'DIV') && isTagName(child, 'SPAN')) {
    return child
  }
}

function getSingleElementChild(el: HTMLElement) {
  const children = Array.from(el.children) as HTMLElement[]
  return children.length === 1 ? children[0] : undefined
}

function hasMeaningfulOwnText(el: HTMLElement) {
  return Array.from(el.childNodes).some((node) => node.nodeType === 3 && !!node.textContent?.trim())
}

function shouldFlattenNoteRoot(el: HTMLElement) {
  if (!isTagName(el, 'P', 'DIV', 'LI')) return false
  if (isNoteContainer(el)) return false

  return !Array.from(el.children).some((child) =>
    isTagName(child, 'P', 'DIV', 'OL', 'UL', 'LI', 'TABLE', 'BLOCKQUOTE', 'FIGURE', 'SECTION', 'ASIDE'),
  )
}

function normalizeNotePopoverContent(root: HTMLElement) {
  const listNodes = [
    ...(root.matches('ol, ul, li') ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('ol, ul, li')),
  ]
  const blockNodes = [
    ...(root.matches('p, ol, ul, li, blockquote') ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('p, ol, ul, li, blockquote')),
  ]

  listNodes.forEach((node) => {
    node.style.setProperty('list-style', 'none', 'important')
    node.style.setProperty('list-style-type', 'none', 'important')
  })
  for (const node of listNodes) {
    if (!isTagName(node, 'OL', 'UL')) continue

    node.style.setProperty('padding', '0', 'important')
    node.style.setProperty('padding-left', '0', 'important')
  }
  blockNodes.forEach((node) => {
    node.style.setProperty('margin', '0', 'important')
    node.style.setProperty('padding', '0', 'important')
  })
}

function cloneElementWithNoteStyles(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement
  copyNoteStyleTree(el, clone)

  return clone
}

function copyNoteStyleTree(source: HTMLElement, target: HTMLElement) {
  target.removeAttribute('style')
  copyNoteTextStyles(source, target)
  copyResolvedResourceAttributes(source, target)

  const sourceElements = Array.from(source.querySelectorAll<HTMLElement>('*'))
  const targetElements = Array.from(target.querySelectorAll<HTMLElement>('*'))

  sourceElements.forEach((sourceElement, index) => {
    const targetElement = targetElements[index]
    if (!targetElement) return

    targetElement.removeAttribute('style')
    copyNoteTextStyles(sourceElement, targetElement)
    copyResolvedResourceAttributes(sourceElement, targetElement)
  })
}

function copyNoteTextStyles(source: HTMLElement, target: HTMLElement) {
  const win = source.ownerDocument.defaultView
  if (!win) return

  const style = win.getComputedStyle(source)
  NOTE_POPOVER_TEXT_STYLE_PROPERTIES.forEach((property) => {
    const value = style.getPropertyValue(property)
    if (!value || value === 'normal' || value === 'auto') return

    target.style.setProperty(property, value, style.getPropertyPriority(property))
  })
}

function copyResolvedResourceAttributes(source: HTMLElement, target: HTMLElement) {
  if (source.tagName === 'IMG' && target.tagName === 'IMG') {
    target.setAttribute('src', (source as HTMLImageElement).src)
  }
  if (source.tagName === 'A' && target.tagName === 'A') {
    target.setAttribute('href', (source as HTMLAnchorElement).href)
  }
}

function isBacklink(link: HTMLAnchorElement, anchor: HTMLAnchorElement) {
  const href = link.getAttribute('href') ?? ''
  const text = link.textContent?.trim() ?? ''
  const role = link.getAttribute('role') ?? ''
  const type = link.getAttribute('epub:type') ?? ''
  const anchorId = getBacklinkTargetId(anchor)

  return (
    /(?:doc-backlink|backlink)/i.test(`${role} ${type}`) ||
    /^[↩←↑返回back]+$/i.test(text) ||
    !!(anchorId && href.endsWith(`#${anchorId}`))
  )
}

function getBacklinkTargetId(anchor: HTMLAnchorElement) {
  return anchor.id || findNearbyEmptyPositionTargetId(anchor) || anchor.closest('[id]')?.id
}

function findNearbyEmptyPositionTargetId(anchor: HTMLAnchorElement) {
  let cur: HTMLElement | null = anchor

  while (cur?.parentElement && cur.parentElement !== cur.ownerDocument.body) {
    const previous = cur.previousElementSibling
    if (isElementNode(previous as ChildNode | undefined) && isEmptyPositionTarget(previous as HTMLElement)) {
      const target = previous as HTMLElement
      return target.id || target.getAttribute('name') || undefined
    }

    cur = cur.parentElement
    if (isTagName(cur, 'P', 'LI', 'BLOCKQUOTE', 'DIV', 'SECTION', 'ARTICLE')) {
      return
    }
  }
}

function unwrapBacklink(link: HTMLAnchorElement) {
  link.replaceWith(...Array.from(link.childNodes))
}
