import { Contents } from '@flow/epub-engine'

import { applyNoteTypographyMarkers, getOriginalBodyTypography } from '../../bodyText'
import type { BookTab, ISection } from '../../models/reader'
import { findReciprocalNoteItem, getElementByIdOrName } from '../../noteIndex'
import { findSectionByLinkedHref, resolveLinkedHrefPath, safeDecodeHref, sameHref } from '../../noteLinks'
import { isNoteMarkerText } from '../../noteSemantics'
import type { TypographyConfiguration } from '../../state'
import { createBodyTextTypographyCss } from '../../styles'

import { getVisiblePageRect, intersectRects, type RectLike, rectFromDomRect } from './noteGeometry'

export type { RectLike } from './noteGeometry'

export interface NotePopoverState {
  anchorRect: RectLike
  pageRect: RectLike
  content: HTMLElement
  writingMode: string
}

export type NotePopoverTypography = TypographyConfiguration

const NOTE_POPOVER_TEXT_STYLE_PROPERTIES = [
  'color',
  'background-color',
  'display',
  'border-collapse',
  'border-spacing',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'list-style-type',
  'list-style-position',
  'text-align',
  'text-indent',
  'white-space',
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
const NOTE_POPOVER_BLOCKED_ELEMENTS = new Set(['BASE', 'EMBED', 'IFRAME', 'LINK', 'META', 'OBJECT', 'SCRIPT', 'STYLE'])
const NOTE_POPOVER_URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'ping',
  'poster',
  'src',
  'srcset',
  'xlink:href',
])
export function createNotePopoverState(
  anchor: HTMLAnchorElement,
  noteElement: HTMLElement,
  container: HTMLElement | null,
  rendition: unknown,
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
    content: cloneNoteElement(noteElement, writingMode),
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
  typography?: NotePopoverTypography,
): Promise<LinkedNoteResult | undefined> {
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('mailto:') || href.includes('://')) return

  const [path = '', hash = ''] = href.split('#')
  if (!hash) return

  const id = safeDecodeHref(hash)
  const target = await findLinkedElement(tab, anchor, path, id, container, typography)
  if (!target) return
  if (isLinkedNoteBacklink(anchor, target.element)) {
    target.cleanup?.()
    return
  }

  const noteItem = findReciprocalNoteItem(anchor, target.element)
  if (!noteItem) {
    target.cleanup?.()
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
  typography?: NotePopoverTypography,
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
    // Other sections may already carry a different baseline's typography.
    // Always start from authored styles and use the referring chapter's baseline.
    return renderLinkedSectionElement(tab, anchor, targetSection, id, container, typography)
  }

  return wrapNoteElement(getElementByIdOrName(currentDocument, id))
}

function wrapNoteElement(element: HTMLElement | undefined): LinkedNoteResult | undefined {
  return element ? { element } : undefined
}

function findRenderedSectionByDocument(tab: BookTab, doc: Document) {
  const canonical = getDocumentCanonicalHref(doc)

  return tab.sections?.find((section) => sameHref(section.href, canonical) || sameHref(section.canonical, canonical))
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
  typography?: NotePopoverTypography,
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

  let contents: Contents | undefined
  const cleanup = () => {
    contents?.destroy()
    iframe.remove()
  }

  try {
    const output = await renderFreshLinkedSectionDocument(tab, section, id)
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

    contents = new Contents(doc)
    tab.rendition?.themes.inject(contents)
    tab.rendition?.themes.applyOverrides(contents)
    const baseline = getOriginalBodyTypography(anchor.ownerDocument)
    const noteItem = findReciprocalNoteItem(anchor, target)
    if (baseline && noteItem && typography) {
      applyNoteTypographyMarkers(contents, baseline.fontFamily, baseline.fontSize, baseline.fontWeight, [
        findRegularNoteElement(noteItem),
      ])
      const { fontFamily, fontSize, fontWeight, secondaryFontFamily } = typography
      contents.addStylesheetCss(
        createBodyTextTypographyCss(doc, { fontFamily, fontSize, fontWeight }, secondaryFontFamily),
        'note-typography',
      )
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

export function isNoteBacklink(anchor: HTMLAnchorElement) {
  if (
    hasToken(anchor.getAttribute('role'), 'doc-backlink', 'backlink') ||
    hasToken(anchor.getAttribute('epub:type') ?? anchor.getAttribute('type'), 'doc-backlink', 'backlink')
  ) {
    return true
  }

  let current = anchor.parentElement
  while (current && current !== current.ownerDocument.body) {
    if (hasStandardNoteSemantics(current)) return true
    current = current.parentElement
  }

  return false
}

function isLinkedNoteBacklink(anchor: HTMLAnchorElement, target: HTMLElement) {
  const noteIds = new Set<string>()
  for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
    if (element.id) noteIds.add(element.id)
    const name = element.getAttribute('name')
    if (name) noteIds.add(name)
  }
  const noteHref = getDocumentCanonicalHref(anchor.ownerDocument)
  const referenceHref = getDocumentCanonicalHref(target.ownerDocument)
  const matches = (candidate: HTMLAnchorElement) => isMatchingNoteReference(candidate, noteIds, noteHref, referenceHref)
  const containingAnchor = target.closest<HTMLAnchorElement>('a[href]')
  if (containingAnchor && matches(containingAnchor)) return true

  for (const candidate of target.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (matches(candidate)) return true
  }

  return false
}

function isMatchingNoteReference(
  candidate: HTMLAnchorElement,
  noteIds: Set<string>,
  noteHref: string | undefined,
  referenceHref: string | undefined,
) {
  if (
    !hasToken(candidate.getAttribute('role'), 'doc-noteref', 'noteref') &&
    !hasToken(candidate.getAttribute('epub:type') ?? candidate.getAttribute('type'), 'noteref')
  ) {
    return false
  }

  const [path = '', hash = ''] = candidate.getAttribute('href')?.split('#') ?? []
  if (!hash || !noteIds.has(safeDecodeHref(hash))) return false
  return !noteHref || !referenceHref || sameHref(resolveLinkedHrefPath(referenceHref, path), noteHref)
}

function findNoteElement(el: HTMLElement, anchor: HTMLAnchorElement) {
  const segmentedNote = createSegmentedNoteElement(el, anchor)
  if (segmentedNote) return segmentedNote

  const regularNote = findRegularNoteElement(el)
  if (hasUsefulNoteElementContent(regularNote)) return regularNote

  return regularNote ?? el
}

function findRegularNoteElement(el: HTMLElement) {
  if (isTagName(el, 'LI', 'DD', 'DT')) return el

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

function cloneNoteElement(el: HTMLElement, writingMode?: string) {
  const clone = cloneElementWithNoteStyles(el)
  normalizeNotePopoverOuterSpacing(clone, writingMode)
  if (clone.style.display === 'none') clone.style.setProperty('display', 'block', 'important')
  if (clone.tagName === 'LI') clone.style.setProperty('display', 'block', 'important')
  applyNotePopoverWritingMode(clone, writingMode)

  return clone
}

function normalizeNotePopoverOuterSpacing(root: HTMLElement, writingMode?: string) {
  root.style.setProperty('margin', '0', 'important')
  root.style.setProperty('padding', '0', 'important')

  const children = Array.from(root.children) as HTMLElement[]
  if (!children.length) return

  if (writingMode === 'vertical-rl') {
    children.forEach((child) => {
      child.style.setProperty('margin-top', '0', 'important')
      child.style.setProperty('margin-bottom', '0', 'important')
    })
    trimNotePopoverBoundaryMargin(root, 'first', 'margin-right')
    trimNotePopoverBoundaryMargin(root, 'last', 'margin-left')
    return
  }

  children.forEach((child) => {
    child.style.setProperty('margin-left', '0', 'important')
    child.style.setProperty('margin-right', '0', 'important')
  })
  trimNotePopoverBoundaryMargin(root, 'first', 'margin-top')
  trimNotePopoverBoundaryMargin(root, 'last', 'margin-bottom')
}

function trimNotePopoverBoundaryMargin(
  root: HTMLElement,
  edge: 'first' | 'last',
  property: 'margin-top' | 'margin-right' | 'margin-bottom' | 'margin-left',
) {
  let current = getNotePopoverBoundaryElement(root, edge)

  while (current) {
    current.style.setProperty(property, '0', 'important')
    current = getNotePopoverBoundaryElement(current, edge)
  }
}

function getNotePopoverBoundaryElement(root: HTMLElement, edge: 'first' | 'last') {
  const nodes = edge === 'first' ? root.childNodes : Array.from(root.childNodes).reverse()

  for (const node of nodes) {
    if (node.nodeType === 3 && node.textContent?.trim()) return
    if (node.nodeType === 1 && 'style' in node) return node as HTMLElement
  }
}

function applyNotePopoverWritingMode(root: HTMLElement, writingMode?: string) {
  if (writingMode !== 'vertical-rl') return

  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
  nodes.forEach((node) => {
    node.style.setProperty('writing-mode', 'vertical-rl', 'important')
    node.style.setProperty('text-orientation', 'mixed', 'important')
  })
}

function cloneElementWithNoteStyles(el: HTMLElement) {
  if (isBlockedNotePopoverElement(el)) {
    return el.ownerDocument.createElement('span')
  }

  const clone = el.cloneNode(true) as HTMLElement
  copyNoteStyleTree(el, clone)

  return clone
}

function copyNoteStyleTree(source: HTMLElement, target: HTMLElement) {
  sanitizeNotePopoverElement(target)
  copyNoteTextStyles(source, target)
  copyResolvedResourceAttributes(source, target)

  const sourceElements = Array.from(source.querySelectorAll<HTMLElement>('*'))
  const targetElements = Array.from(target.querySelectorAll<HTMLElement>('*'))

  sourceElements.forEach((sourceElement, index) => {
    const targetElement = targetElements[index]
    if (!targetElement) return

    if (isBlockedNotePopoverElement(targetElement)) {
      targetElement.remove()
      return
    }

    sanitizeNotePopoverElement(targetElement)
    copyNoteTextStyles(sourceElement, targetElement)
    copyResolvedResourceAttributes(sourceElement, targetElement)
  })
}

function isBlockedNotePopoverElement(element: Element) {
  return NOTE_POPOVER_BLOCKED_ELEMENTS.has(element.tagName.toUpperCase())
}

function sanitizeNotePopoverElement(element: HTMLElement) {
  for (let index = element.attributes.length - 1; index >= 0; index--) {
    const attribute = element.attributes.item(index)
    if (!attribute) continue

    const name = attribute.name.toLowerCase()
    if (name === 'style' || name.startsWith('on') || NOTE_POPOVER_URL_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name)
    }
  }
}

function copyNoteTextStyles(source: HTMLElement, target: HTMLElement) {
  const win = source.ownerDocument.defaultView
  if (!win) return

  const style = source.isConnected ? win.getComputedStyle(source) : source.style
  NOTE_POPOVER_TEXT_STYLE_PROPERTIES.forEach((property) => {
    const value = style.getPropertyValue(property)
    if (!value || value === 'auto') return

    target.style.setProperty(property, value, style.getPropertyPriority(property))
  })
}

function copyResolvedResourceAttributes(source: HTMLElement, target: HTMLElement) {
  if (source.tagName === 'IMG' && target.tagName === 'IMG') {
    const src = (source as HTMLImageElement).src
    if (isSafeNotePopoverImageUrl(src)) target.setAttribute('src', src)

    const style = source.isConnected ? source.ownerDocument.defaultView?.getComputedStyle(source) : source.style
    for (const property of ['width', 'height', 'aspect-ratio']) {
      const value = style?.getPropertyValue(property)
      if (value) target.style.setProperty(property, value, 'important')
    }
    const width = Number.parseFloat(style?.width ?? '')
    const height = Number.parseFloat(style?.height ?? '')
    if (width > 0 && height > 0) {
      target.style.setProperty('width', `${width}px`, 'important')
      target.style.setProperty('height', 'auto', 'important')
      target.style.setProperty('aspect-ratio', `${width} / ${height}`, 'important')
    }
    target.style.setProperty('max-width', '100%', 'important')
  }
}

function isSafeNotePopoverImageUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'blob:') return true
    return url.protocol === 'data:' && /^data:image\//i.test(value)
  } catch {
    return false
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
