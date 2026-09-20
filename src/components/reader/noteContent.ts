import { Contents } from '@flow/epub-engine'

import { applyNoteTypographyMarkers, getOriginalBodyTypography } from '../../bodyText'
import type { BookTab, ISection } from '../../models/reader'
import { findNoteItem, getElementByIdOrName } from '../../noteIndex'
import { findSectionByLinkedHref, resolveLinkedHrefPath, safeDecodeHref, sameHref } from '../../noteLinks'
import { hasNoteContainerSemantics, hasToken } from '../../noteSemantics'
import type { TypographyConfiguration } from '../../state'
import { createBodyTextTypographyCss } from '../../styles'

import { getVisiblePageRect, intersectRects, type RectLike, rectFromDomRect } from './noteGeometry'
import { cloneNoteElement } from './notePopoverContent'

export type { RectLike } from './noteGeometry'

export interface NotePopoverState {
  anchorRect: RectLike
  pageRect: RectLike
  content: HTMLElement
  writingMode: string
}

export type NotePopoverTypography = TypographyConfiguration

export function createNotePopoverState(
  anchor: HTMLAnchorElement,
  noteElement: HTMLElement,
  container: HTMLElement | null,
  rendition: unknown,
  tab: BookTab,
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
    content: cloneNoteElement(noteElement, writingMode, anchor, (link) => getBookLinkDisplayTarget(tab, link)),
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
  const noteItem = !isLinkedNoteBacklink(anchor, target.element) && findNoteItem(anchor, target.element)
  if (!noteItem) {
    target.cleanup?.()
    return
  }

  return { element: noteItem, cleanup: target.cleanup }
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
  if (!tab.epub || !container || !section.url) return

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
    // Load authored content: a previously rendered section may carry another chapter's typography.
    const document = (await tab.epub.load(section.url)) as Document
    await section.hooks?.content?.trigger(document, section)
    if (!getElementByIdOrName(document, id)) {
      cleanup()
      return
    }
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

    iframe.srcdoc = document.documentElement.outerHTML
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
    const noteItem = findNoteItem(anchor, target)
    if (baseline && noteItem && typography) {
      applyNoteTypographyMarkers(contents, baseline.fontFamily, baseline.fontSize, baseline.fontWeight, [noteItem])
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
    if (hasNoteContainerSemantics(current)) return true
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
