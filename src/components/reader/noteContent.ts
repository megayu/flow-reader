import type { BookTab } from '../../models/reader'
import { findNoteItem, getElementByIdOrName } from '../../noteIndex'
import { findSectionByLinkedHref, safeDecodeHref, sameHref, splitLinkedHref } from '../../noteLinks'
import { isNoteBacklink } from '../../noteSemantics'

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
  if (!target) return
  const sourceSection = findSectionByLinkedHref(tab.sections, sourceHref, '')
  const item = findNoteItem(anchor, target, !!section && !!sourceSection && section.index > sourceSection.index)
  if (!item) return
  // Canonical URLs may use the native resource server; navigation needs a spine href.
  const noteHref = (section ?? sourceSection)?.href
  return cloneNoteElement(
    item,
    (link) => getBookLinkDisplayTarget(tab, link, noteHref),
    !hideEndnotes && noteHref ? `${noteHref}#${safeDecodeHref(hash)}` : undefined,
  )
}

function getDocumentCanonicalHref(doc: Document) {
  return doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined
}
