import { isNoteBacklinkMarkerText } from './noteSemantics'

export interface NoteIndex {
  getHideTargets(): HTMLElement[]
  getItemForAnchor(anchor: HTMLAnchorElement): HTMLElement | undefined
  getTextTargets(): HTMLElement[]
}

const indexCache = new WeakMap<Document, NoteIndex>()

export function getNoteIndex(document: Document) {
  const cached = indexCache.get(document)
  if (cached) return cached

  const index = createNoteIndex(document)
  indexCache.set(document, index)

  return index
}

export function findReciprocalNoteItem(
  anchor: HTMLAnchorElement,
  target: HTMLElement,
) {
  let cur: HTMLElement | null = target

  while (cur && cur !== cur.ownerDocument.body) {
    if (isPotentialNoteContentElement(cur)) {
      const backlink = findLeadingNoteBacklink(cur)
      if (
        backlink &&
        hasContentAfterNoteBacklink(cur, backlink) &&
        backlinkTargetsAnchor(backlink, anchor)
      ) {
        return cur
      }
    }

    cur = cur.parentElement
  }
}

function createNoteIndex(document: Document): NoteIndex {
  const items = collectLinkedNoteItems(document)
  const itemSet = new Set(items)
  const hideTargets = uniqueElements(
    items.map((item) => findNoteHideTarget(item, itemSet)),
  )

  return {
    getHideTargets: () => hideTargets,
    getItemForAnchor: (anchor) => findAncestorInSet(anchor, itemSet),
    getTextTargets: () => items,
  }
}

function collectLinkedNoteItems(document: Document) {
  const items: HTMLElement[] = []

  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (!isUsableHashLink(anchor)) return

    const item = findLinkedNoteItem(anchor)
    if (item) items.push(item)
  })

  return uniqueElements(items)
}

function isUsableHashLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')?.trim()
  if (!href || href.startsWith('mailto:') || href.includes('://')) return false
  return href.includes('#')
}

function isPotentialNoteBacklink(anchor: HTMLAnchorElement, item: HTMLElement) {
  return (
    isNoteBacklinkMarkerText(anchor.textContent) ||
    hasLocalReciprocalLink(anchor, item)
  )
}

function findLinkedNoteItem(anchor: HTMLAnchorElement) {
  let cur = anchor.parentElement

  while (cur && cur !== cur.ownerDocument.body) {
    if (
      isPotentialNoteContentElement(cur) &&
      findLeadingNoteBacklink(cur) === anchor &&
      hasContentAfterNoteBacklink(cur, anchor) &&
      isPotentialNoteBacklink(anchor, cur)
    ) {
      return cur
    }

    cur = cur.parentElement
  }
}

function findNoteHideTarget(item: HTMLElement, itemSet: Set<HTMLElement>) {
  let current = item

  while (
    current.parentElement &&
    current.parentElement !== current.ownerDocument.body
  ) {
    if (!containsOnlyNoteItems(current.parentElement, itemSet)) break
    current = current.parentElement
  }

  return current
}

function containsOnlyNoteItems(
  element: HTMLElement,
  itemSet: Set<HTMLElement>,
) {
  let hasNote = false
  let hasOtherContent = false

  element.childNodes.forEach((node) => {
    if (hasOtherContent) return
    const result = classifyNodeForNoteContainer(node, itemSet)
    hasNote ||= result.hasNote
    hasOtherContent ||= result.hasOtherContent
  })

  return hasNote && !hasOtherContent
}

function classifyNodeForNoteContainer(
  node: ChildNode,
  itemSet: Set<HTMLElement>,
): { hasNote: boolean; hasOtherContent: boolean } {
  if (node.nodeType === 3) {
    return {
      hasNote: false,
      hasOtherContent: !!node.textContent?.trim(),
    }
  }

  if (!isElementNode(node)) {
    return { hasNote: false, hasOtherContent: false }
  }

  const element = node as HTMLElement
  if (itemSet.has(element)) return { hasNote: true, hasOtherContent: false }
  if (isTagName(element, 'BR', 'HR')) {
    return { hasNote: false, hasOtherContent: false }
  }

  let hasNote = false
  let hasOtherContent = false
  element.childNodes.forEach((child) => {
    if (hasOtherContent) return
    const result = classifyNodeForNoteContainer(child, itemSet)
    hasNote ||= result.hasNote
    hasOtherContent ||= result.hasOtherContent
  })

  return { hasNote, hasOtherContent: hasOtherContent || !hasNote }
}

function findLeadingNoteBacklink(el: HTMLElement) {
  const first = getFirstMeaningfulChild(el)
  if (!first || !isElementNode(first)) return

  return findLeadingNoteBacklinkInElement(first as HTMLElement)
}

function findLeadingNoteBacklinkInElement(
  el: HTMLElement,
): HTMLAnchorElement | undefined {
  if (isTagName(el, 'A')) {
    return isUsableHashLink(el as HTMLAnchorElement)
      ? (el as HTMLAnchorElement)
      : undefined
  }
  if (isTagName(el, 'SUP', 'SUB')) return

  const direct = el.querySelector<HTMLAnchorElement>('a[href]')
  if (direct && isUsableHashLink(direct)) return direct
}

function hasContentAfterNoteBacklink(
  candidate: HTMLElement,
  backlink: HTMLAnchorElement,
) {
  const text = (candidate.textContent ?? '').replace(
    backlink.textContent ?? '',
    '',
  )

  return !!text.trim() || !!candidate.querySelector('img, svg, math')
}

function backlinkTargetsAnchor(
  backlink: HTMLAnchorElement,
  anchor: HTMLAnchorElement,
) {
  const [, hash = ''] = backlink.getAttribute('href')?.split('#') ?? []
  if (!hash) return false

  const target = getElementByIdOrName(anchor.ownerDocument, safeDecode(hash))
  if (!target) return false

  return (
    target === anchor ||
    anchor.contains(target) ||
    target.contains(anchor) ||
    target.closest('a[href]') === anchor
  )
}

function hasLocalReciprocalLink(
  backlink: HTMLAnchorElement,
  item: HTMLElement,
) {
  const [, backlinkHash = ''] = backlink.getAttribute('href')?.split('#') ?? []
  if (!backlinkHash) return false

  const bodyTarget = getElementByIdOrName(
    backlink.ownerDocument,
    safeDecode(backlinkHash),
  )
  const sourceAnchor = bodyTarget?.closest(
    'a[href]',
  ) as HTMLAnchorElement | null
  const [, sourceHash = ''] =
    sourceAnchor?.getAttribute('href')?.split('#') ?? []
  if (!sourceHash) return false

  const noteTarget = getElementByIdOrName(
    item.ownerDocument,
    safeDecode(sourceHash),
  )

  return !!noteTarget && (noteTarget === item || item.contains(noteTarget))
}

function getElementByIdOrName(doc: Document, id: string) {
  return (
    doc.getElementById(id) ??
    ([...doc.querySelectorAll('[name]')].find(
      (el) => el.getAttribute('name') === id,
    ) as HTMLElement | undefined)
  )
}

function safeDecode(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function isPotentialNoteContentElement(el: HTMLElement) {
  return isTagName(
    el,
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DIV',
    'DL',
    'LI',
    'OL',
    'P',
    'SECTION',
    'UL',
  )
}

function findAncestorInSet<T extends HTMLElement>(
  element: HTMLElement,
  set: Set<T>,
) {
  let cur: HTMLElement | null = element

  while (cur && cur !== cur.ownerDocument.body) {
    if (set.has(cur as T)) return cur as T
    cur = cur.parentElement
  }
}

function getFirstMeaningfulChild(el: HTMLElement) {
  return [...el.childNodes].find((node) => {
    if (isElementNode(node)) return true
    return !!node.textContent?.trim()
  })
}

function uniqueElements<T extends HTMLElement>(elements: T[]) {
  return [...new Set(elements)]
}

function isElementNode(node: ChildNode | undefined) {
  return (
    node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
  )
}

function isTagName(el: Element, ...names: string[]) {
  const tagName = el.tagName.toUpperCase()
  return names.some((name) => tagName === name)
}
