import { resolveLinkedHrefPath, safeDecodeHref, sameHref, splitLinkedHref } from './noteLinks'
import {
  hasDeclaredNoteSemantics,
  hasNoteCollectionSemantics,
  hasNoteContainerSemantics,
  isExplicitNoteLink,
  isNoteBacklink,
} from './noteSemantics'

export interface NoteIndex {
  getHideTargets(): HTMLElement[]
  getItemForAnchor(anchor: HTMLAnchorElement): HTMLElement | undefined
  getItemForTarget(target: HTMLElement): HTMLElement | undefined
  getTextTargets(): HTMLElement[]
}

const indexCache = new WeakMap<Document, NoteIndex>()
type NoteTargetLookup = typeof getElementByIdOrName

export function getNoteIndex(document: Document) {
  const cached = indexCache.get(document)
  if (cached) return cached

  const index = createNoteIndex(document)
  indexCache.set(document, index)

  return index
}

export function findNoteItem(anchor: HTMLAnchorElement, target: HTMLElement) {
  return getNoteIndex(target.ownerDocument).getItemForTarget(target) ?? classifyLinkedNoteItem(anchor, target)
}

function createNoteIndex(document: Document): NoteIndex {
  const { items, itemsByTarget } = collectLinkedNoteItems(document)
  const semanticRoots = Array.from(
    document.querySelectorAll<HTMLElement>('[data-type], [role], [epub\\:type], [type]'),
  ).filter(hasDeclaredNoteSemantics)
  const itemSet = new Set(items)
  const hideTargets = outermostElements([...semanticRoots, ...collectNoteHideTargets(items, itemSet)])
  const textTargets = uniqueElements([...items, ...semanticRoots])

  return {
    getHideTargets: () => hideTargets,
    getItemForAnchor: (anchor) => findAncestorInSet(anchor, itemSet),
    getItemForTarget: (target) => itemsByTarget.get(target),
    getTextTargets: () => textTargets,
  }
}

function collectLinkedNoteItems(document: Document) {
  const items: HTMLElement[] = []
  const itemsByTarget = new Map<HTMLElement, HTMLElement>()
  const getTarget = createNoteTargetLookup()

  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (!isUsableHashLink(anchor) || isNoteBacklink(anchor)) return

    const target = getLinkedHashTarget(anchor, getTarget)
    if (!target) return
    // Known limitation: preceding class-only notes are excluded from hiding,
    // although popup resolution can still recognize their container semantics.
    if (!isExplicitNoteLink(anchor) && !isHashTargetAfterSource(anchor, target)) return

    const item = classifyLinkedNoteItem(anchor, target, getTarget)
    if (item) {
      items.push(item)
      itemsByTarget.set(target, item)
    }
  })

  return { items: uniqueElements(items), itemsByTarget }
}

function isUsableHashLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')?.trim()
  if (!href || href.startsWith('mailto:') || href.includes('://')) return false
  return href.includes('#')
}

function getLinkedHashTarget(anchor: HTMLAnchorElement, getTarget: NoteTargetLookup) {
  const { path, hash } = splitLinkedHref(anchor.getAttribute('href')?.trim() ?? '')
  if (!hash) return

  const canonical = anchor.ownerDocument.querySelector?.('link[rel="canonical"]')?.getAttribute('href')
  if (path && canonical && !sameHref(resolveLinkedHrefPath(canonical, path), canonical)) return

  return getTarget(anchor.ownerDocument, safeDecodeHref(hash))
}

function isHashTargetAfterSource(source: HTMLAnchorElement, target: HTMLElement) {
  if (source === target) return false

  const position = source.compareDocumentPosition?.(target)
  if (typeof position !== 'number') return true

  return !!(position & 4)
}

function classifyLinkedNoteItem(
  anchor: HTMLAnchorElement,
  target: HTMLElement,
  getTarget: NoteTargetLookup = getElementByIdOrName,
) {
  const semanticItem = findSemanticNoteItem(target)
  if (semanticItem) return semanticItem

  if (isExplicitNoteLink(anchor)) return findExplicitNoteItem(target)

  if (anchor.ownerDocument === target.ownerDocument && !isHashTargetAfterSource(anchor, target)) return

  return findEmptyTargetNoteItem(anchor, target, getTarget) ?? findBacklinkedTargetNoteItem(anchor, target, getTarget)
}

function findBacklinkedTargetNoteItem(anchor: HTMLAnchorElement, target: HTMLElement, getTarget: NoteTargetLookup) {
  if (isEmptyPositionTarget(target)) return

  for (const candidate of getBacklinkedTargetNoteItemCandidates(target)) {
    const backlink = findFirstHashLink(candidate)
    if (
      backlink &&
      backlinkTargetsAnchor(backlink, anchor, getTarget) &&
      hasUsefulReciprocalNoteContent(candidate, backlink)
    ) {
      return candidate
    }
  }
}

function getBacklinkedTargetNoteItemCandidates(target: HTMLElement) {
  const candidates: HTMLElement[] = []
  let cur: HTMLElement | null = target

  while (cur && cur !== cur.ownerDocument.body) {
    if (
      isPotentialNoteContentElement(cur) &&
      (cur === target || isTargetAtStartOfCandidate(cur, target) || hasNoteContainerSemantics(cur))
    ) {
      if (isTagName(cur, 'DT') && cur.parentElement && isTagName(cur.parentElement, 'DL')) {
        candidates.push(cur.parentElement)
      } else {
        candidates.push(cur)
      }
    }

    if (isPotentialNoteContentElement(cur) && cur !== target) break
    cur = cur.parentElement
  }

  return uniqueElements(candidates)
}

function findEmptyTargetNoteItem(anchor: HTMLAnchorElement, target: HTMLElement, getTarget: NoteTargetLookup) {
  if (!isEmptyPositionTarget(target)) return

  for (const candidate of getEmptyTargetNoteItemCandidates(target)) {
    const backlink = findFirstHashLink(candidate)
    if (
      backlink &&
      backlinkTargetsAnchor(backlink, anchor, getTarget) &&
      hasUsefulReciprocalNoteContent(candidate, backlink)
    ) {
      return candidate
    }
  }
}

function getEmptyTargetNoteItemCandidates(target: HTMLElement) {
  const candidates: HTMLElement[] = []
  const next = target.nextElementSibling
  if (isHTMLElement(next) && isPotentialNoteContentElement(next)) {
    candidates.push(next)
  }

  let cur: HTMLElement | null = target
  while (cur?.parentElement && cur.parentElement !== cur.ownerDocument.body) {
    const parent: HTMLElement = cur.parentElement

    if (isPotentialNoteContentElement(parent) && isTargetAtStartOfCandidate(parent, target)) {
      candidates.push(parent)
      break
    }

    if (!isInlineNoteTargetWrapper(parent)) break
    const parentNext = parent.nextElementSibling
    if (isHTMLElement(parentNext) && isPotentialNoteContentElement(parentNext)) {
      candidates.push(parentNext)
    }

    cur = parent
  }

  return uniqueElements(candidates)
}

function findSemanticNoteItem(target: HTMLElement) {
  let item: HTMLElement | undefined
  let listItem: HTMLElement | undefined
  let cur: HTMLElement | null = target

  // Body-level note collections can be hidden, but are not resolved into popup items.
  while (cur && cur !== cur.ownerDocument.body) {
    if (!item && isPotentialNoteContentElement(cur)) item = cur
    if (!listItem && isTagName(cur, 'LI', 'DD')) listItem = cur
    if (hasNoteContainerSemantics(cur)) {
      return listItem ?? (hasNoteCollectionSemantics(cur) ? (item ?? cur) : cur)
    }
    cur = cur.parentElement
  }
}

function findExplicitNoteItem(target: HTMLElement) {
  let cur: HTMLElement | null = target

  while (cur && cur !== cur.ownerDocument.body) {
    if (isPotentialNoteContentElement(cur)) return cur
    cur = cur.parentElement
  }

  return target
}

function collectNoteHideTargets(items: HTMLElement[], itemSet: Set<HTMLElement>) {
  // Construction-only state must not be retained by the document's NoteIndex.
  const containers = new WeakMap<HTMLElement, boolean>()
  return uniqueElements(items.map((item) => findNoteHideTarget(item, itemSet, containers)))
}

function findNoteHideTarget(item: HTMLElement, itemSet: Set<HTMLElement>, containers: WeakMap<HTMLElement, boolean>) {
  let semanticRoot: HTMLElement | undefined
  for (
    let ancestor = item.parentElement;
    ancestor && ancestor !== item.ownerDocument.body;
    ancestor = ancestor.parentElement
  ) {
    if (hasNoteContainerSemantics(ancestor)) semanticRoot = ancestor
  }
  if (semanticRoot) return semanticRoot
  let current = item

  while (current.parentElement && current.parentElement !== current.ownerDocument.body) {
    if (!containsOnlyNoteItems(current.parentElement, itemSet, containers)) break
    current = current.parentElement
  }

  return current
}

function containsOnlyNoteItems(
  element: HTMLElement,
  itemSet: Set<HTMLElement>,
  containers: WeakMap<HTMLElement, boolean>,
): boolean {
  const cached = containers.get(element)
  if (cached !== undefined) return cached

  let hasNote = false
  let hasOtherContent = false

  for (const node of element.childNodes) {
    const result = classifyNodeForNoteContainer(node, itemSet, containers)
    hasNote ||= result.hasNote
    hasOtherContent ||= result.hasOtherContent
    if (hasOtherContent) break
  }

  const onlyNotes = hasNote && !hasOtherContent
  containers.set(element, onlyNotes)
  return onlyNotes
}

function classifyNodeForNoteContainer(
  node: ChildNode,
  itemSet: Set<HTMLElement>,
  containers: WeakMap<HTMLElement, boolean>,
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

  const onlyNotes = containsOnlyNoteItems(element, itemSet, containers)
  return { hasNote: onlyNotes, hasOtherContent: !onlyNotes }
}

function findFirstHashLink(el: HTMLElement): HTMLAnchorElement | undefined {
  if (isTagName(el, 'A')) {
    return isUsableHashLink(el as HTMLAnchorElement) ? (el as HTMLAnchorElement) : undefined
  }

  const first = el.querySelector<HTMLAnchorElement>('a[href]')
  return first && isUsableHashLink(first) ? first : undefined
}

function hasUsefulReciprocalNoteContent(candidate: HTMLElement, backlink: HTMLAnchorElement) {
  if (candidate.querySelector('img, svg, math')) return true
  if (hasTextOutsideElement(candidate, backlink)) return true

  return !!backlink.textContent?.trim() || !!backlink.querySelector('img, svg, math')
}

function hasTextOutsideElement(root: HTMLElement, excluded: HTMLElement) {
  for (const node of Array.from(root.childNodes)) {
    if (excluded === node || excluded.contains(node)) continue

    if (node.nodeType === 3 && node.textContent?.trim()) return true
    if (isElementNode(node) && hasTextOutsideElement(node as HTMLElement, excluded)) {
      return true
    }
  }

  return false
}

function isTargetAtStartOfCandidate(candidate: HTMLElement, target: HTMLElement) {
  if (candidate === target) return true

  const path: HTMLElement[] = []
  let cur: HTMLElement | null = target
  while (cur && cur !== candidate) {
    path.unshift(cur)
    cur = cur.parentElement
  }
  if (cur !== candidate) return false

  let parent = candidate
  for (const child of path) {
    if (getFirstMeaningfulChild(parent) !== child) return false
    parent = child
  }

  return true
}

function getFirstMeaningfulChild(el: HTMLElement) {
  return Array.from(el.childNodes).find(
    (node) => isElementNode(node) || (node.nodeType === 3 && !!node.textContent?.trim()),
  )
}

function isInlineNoteTargetWrapper(el: HTMLElement) {
  return isTagName(el, 'A', 'B', 'EM', 'FONT', 'I', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP')
}

export function backlinkTargetsAnchor(
  backlink: HTMLAnchorElement,
  anchor: HTMLAnchorElement,
  getTarget: NoteTargetLookup = getElementByIdOrName,
) {
  const { path, hash } = splitLinkedHref(backlink.getAttribute('href')?.trim() ?? '')
  if (!hash) return false

  const sourceHref = anchor.ownerDocument.querySelector?.('link[rel="canonical"]')?.getAttribute('href')
  const noteHref = backlink.ownerDocument.querySelector?.('link[rel="canonical"]')?.getAttribute('href')
  if (sourceHref && noteHref && !sameHref(resolveLinkedHrefPath(noteHref, path), sourceHref)) return false

  const target = getTarget(anchor.ownerDocument, safeDecodeHref(hash))
  // Publishers place reference IDs on the link or its wrappers; nearby siblings
  // do not establish ownership of the reference.
  return !!target && (target === anchor || target.contains(anchor) || anchor.contains(target))
}

export function getElementByIdOrName(doc: Document, id: string) {
  return (
    doc.getElementById(id) ??
    ([...doc.querySelectorAll('[name]')].find((el) => el.getAttribute('name') === id) as HTMLElement | undefined)
  )
}

function createNoteTargetLookup(): NoteTargetLookup {
  let namedElements: NodeListOf<HTMLElement> | undefined
  let namedTargets: Map<string, HTMLElement> | undefined

  return (doc, id) => {
    const target = doc.getElementById(id)
    if (target) return target

    // A single name fallback needs no map; repeated fallbacks reuse the queried elements.
    if (!namedElements) {
      namedElements = doc.querySelectorAll<HTMLElement>('[name]')
      for (const element of namedElements) {
        if (element.getAttribute('name') === id) return element
      }
      return
    }
    if (!namedElements.length) return

    if (!namedTargets) {
      namedTargets = new Map()
      for (const element of namedElements) {
        const name = element.getAttribute('name')!
        if (!namedTargets.has(name)) namedTargets.set(name, element)
      }
    }
    return namedTargets.get(id)
  }
}

function isPotentialNoteContentElement(el: HTMLElement) {
  return isTagName(el, 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'LI', 'OL', 'P', 'SECTION', 'TABLE', 'UL')
}

function isEmptyPositionTarget(el: HTMLElement) {
  return isTagName(el, 'A', 'SPAN') && !!(el.id || el.getAttribute('name')) && !el.textContent?.trim()
}

function findAncestorInSet<T extends HTMLElement>(element: HTMLElement, set: Set<T>) {
  let cur: HTMLElement | null = element

  while (cur && cur !== cur.ownerDocument.body) {
    if (set.has(cur as T)) return cur as T
    cur = cur.parentElement
  }
}

function uniqueElements<T extends HTMLElement>(elements: T[]) {
  return [...new Set(elements)]
}

function outermostElements(elements: HTMLElement[]) {
  const roots = new Set(elements)
  const covered = new WeakMap<HTMLElement, boolean>()
  const hasAncestor = (element: HTMLElement): boolean => {
    const cached = covered.get(element)
    if (cached !== undefined) return cached
    const parent = element.parentElement
    const result = !!parent && (roots.has(parent) || hasAncestor(parent))
    covered.set(element, result)
    return result
  }
  return [...roots].filter((element) => !hasAncestor(element))
}

function isElementNode(node: ChildNode | undefined) {
  return node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
}

function isHTMLElement(node: Element | null | undefined): node is HTMLElement {
  return node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
}

function isTagName(el: Element, ...names: string[]) {
  const tagName = el.tagName.toUpperCase()
  return names.some((name) => tagName === name)
}
