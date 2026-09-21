import type { BookTab } from '../../models/reader'
import { findNoteItem, getElementByIdOrName } from '../../noteIndex'
import {
  findSectionByLinkedHref,
  resolveLinkedHrefPath,
  safeDecodeHref,
  sameHref,
  splitLinkedHref,
} from '../../noteLinks'
import { isExplicitNoteLink, isNoteBacklink } from '../../noteSemantics'

import { cloneNoteElement } from './notePopoverContent'

export function getAnchorFromEvent(event: MouseEvent) {
  return (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]') ?? undefined
}

export function getInternalBookHref(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')?.trim()
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return
  return href
}

export function getBookLinkDisplayTarget(tab: BookTab, anchor: HTMLAnchorElement, baseHref?: string) {
  const href = getInternalBookHref(anchor)
  if (!href) return
  const { path, hash } = splitLinkedHref(href)
  if (!path && !hash) return
  const sourceHref = baseHref ?? getDocumentCanonicalHref(anchor.ownerDocument) ?? tab.section?.href
  const section = findSectionByLinkedHref(tab.sections, sourceHref, path)
  if (!section?.href) return
  return hash ? `${section.href}#${safeDecodeHref(hash)}` : section.href
}

export async function getLinkedNote(tab: BookTab, anchor: HTMLAnchorElement, hideEndnotes?: boolean) {
  if (isNoteBacklink(anchor)) return
  const href = getInternalBookHref(anchor)
  if (!href) return
  const { path, hash } = splitLinkedHref(href)
  if (!hash) return
  const sourceHref = getDocumentCanonicalHref(anchor.ownerDocument) ?? tab.section?.href
  const section = findSectionByLinkedHref(tab.sections, sourceHref, path)
  let doc = anchor.ownerDocument
  // Unknown paths may resolve local notes, but known remote paths must use their own document.
  if (section && !sameHref(sourceHref, section.href)) {
    if (!tab.epub || !section.url) return
    doc = (await tab.epub.load(section.url)) as Document
    doc.querySelectorAll('link[rel~="stylesheet"], style').forEach((node) => node.remove())
    // Resolve resources without mounting another frame or importing its chapter stylesheet.
    await section.hooks?.content?.trigger(doc, section)
  }
  const target = getElementByIdOrName(doc, safeDecodeHref(hash))
  if (!target || isLinkedNoteBacklink(anchor, target)) return
  const item = findNoteItem(anchor, target)
  if (!item) return
  const noteHref = section?.href ?? sourceHref
  return cloneNoteElement(
    item,
    anchor,
    (link) => getBookLinkDisplayTarget(tab, link, noteHref),
    !hideEndnotes && noteHref ? `${noteHref}#${safeDecodeHref(hash)}` : undefined,
  )
}

function getDocumentCanonicalHref(doc: Document) {
  return doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined
}

function isLinkedNoteBacklink(anchor: HTMLAnchorElement, target: HTMLElement) {
  // A declared reference may point to a note whose return link is also marked noteref.
  if (isExplicitNoteLink(anchor)) return false

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
  if (!isExplicitNoteLink(candidate)) return false

  const { path, hash } = splitLinkedHref(candidate.getAttribute('href') ?? '')
  if (!hash || !noteIds.has(safeDecodeHref(hash))) return false
  return !noteHref || !referenceHref || sameHref(resolveLinkedHrefPath(referenceHref, path), noteHref)
}
