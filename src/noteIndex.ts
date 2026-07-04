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
  return findNoteItemForTarget(anchor, target)
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

function findLinkedNoteItem(anchor: HTMLAnchorElement) {
  const target = getLinkedHashTarget(anchor)
  if (!target || !isHashTargetAfterSource(anchor, target)) return

  return findNoteItemForTarget(anchor, target)
}

function getLinkedHashTarget(anchor: HTMLAnchorElement) {
  const [, hash = ''] = anchor.getAttribute('href')?.split('#') ?? []
  if (!hash) return

  return getElementByIdOrName(anchor.ownerDocument, safeDecode(hash))
}

function isHashTargetAfterSource(
  source: HTMLAnchorElement,
  target: HTMLElement,
) {
  if (source === target) return false

  const position = source.compareDocumentPosition?.(target)
  if (typeof position !== 'number') return true

  return !!(position & 4)
}

function findNoteItemForTarget(anchor: HTMLAnchorElement, target: HTMLElement) {
  return (
    findEmptyTargetNoteItem(anchor, target) ??
    findBacklinkedTargetNoteItem(anchor, target) ??
    findSemanticLinkedNoteItem(anchor, target)
  )
}

function findBacklinkedTargetNoteItem(
  anchor: HTMLAnchorElement,
  target: HTMLElement,
) {
  if (isEmptyPositionTarget(target)) return

  for (const candidate of getBacklinkedTargetNoteItemCandidates(target)) {
    const backlink = findFirstHashLink(candidate)
    if (
      backlink &&
      isConfirmedNoteBacklink(backlink, anchor) &&
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
      (cur === target ||
        isTargetAtStartOfCandidate(cur, target) ||
        isSemanticNoteTarget(cur))
    ) {
      if (
        isTagName(cur, 'DT') &&
        cur.parentElement &&
        isTagName(cur.parentElement, 'DL')
      ) {
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

function findEmptyTargetNoteItem(
  anchor: HTMLAnchorElement,
  target: HTMLElement,
) {
  if (!isEmptyPositionTarget(target)) return

  for (const candidate of getEmptyTargetNoteItemCandidates(target)) {
    const backlink = findFirstHashLink(candidate)
    if (
      backlink &&
      isConfirmedNoteBacklink(backlink, anchor) &&
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

    if (
      isPotentialNoteContentElement(parent) &&
      isTargetAtStartOfCandidate(parent, target)
    ) {
      candidates.push(parent)
      break
    }

    if (!isInlineNoteTargetWrapper(parent)) break
    const parentNext = parent.nextElementSibling
    if (
      isHTMLElement(parentNext) &&
      isPotentialNoteContentElement(parentNext)
    ) {
      candidates.push(parentNext)
    }

    cur = parent
  }

  return uniqueElements(candidates)
}

function isConfirmedNoteBacklink(
  backlink: HTMLAnchorElement,
  anchor: HTMLAnchorElement,
) {
  return backlinkTargetsAnchor(backlink, anchor)
}

function findSemanticLinkedNoteItem(
  anchor: HTMLAnchorElement,
  target: HTMLElement,
) {
  if (!isSemanticNoteSourceAnchor(anchor)) return

  let cur: HTMLElement | null = target
  while (cur && cur !== cur.ownerDocument.body) {
    if (isSemanticNoteTarget(cur) && hasUsefulNoteContent(cur)) return cur
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

function findFirstHashLink(el: HTMLElement): HTMLAnchorElement | undefined {
  if (isTagName(el, 'A')) {
    return isUsableHashLink(el as HTMLAnchorElement)
      ? (el as HTMLAnchorElement)
      : undefined
  }

  const first = el.querySelector<HTMLAnchorElement>('a[href]')
  return first && isUsableHashLink(first) ? first : undefined
}

function hasUsefulReciprocalNoteContent(
  candidate: HTMLElement,
  backlink: HTMLAnchorElement,
) {
  if (candidate.querySelector('img, svg, math')) return true
  if (hasTextOutsideElement(candidate, backlink)) return true

  return (
    !!backlink.textContent?.trim() || !!backlink.querySelector('img, svg, math')
  )
}

function hasTextOutsideElement(root: HTMLElement, excluded: HTMLElement) {
  for (const node of Array.from(root.childNodes)) {
    if (excluded === node || excluded.contains(node)) continue

    if (node.nodeType === 3 && !!node.textContent?.trim()) return true
    if (
      isElementNode(node) &&
      hasTextOutsideElement(node as HTMLElement, excluded)
    ) {
      return true
    }
  }

  return false
}

function hasUsefulNoteContent(candidate: HTMLElement) {
  return (
    !!candidate.textContent?.trim() ||
    !!candidate.querySelector('img, svg, math')
  )
}

function isTargetAtStartOfCandidate(
  candidate: HTMLElement,
  target: HTMLElement,
) {
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
    (node) =>
      isElementNode(node) ||
      (node.nodeType === 3 && !!node.textContent?.trim()),
  )
}

function isInlineNoteTargetWrapper(el: HTMLElement) {
  return isTagName(
    el,
    'A',
    'B',
    'EM',
    'FONT',
    'I',
    'SMALL',
    'SPAN',
    'STRONG',
    'SUB',
    'SUP',
  )
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
    target.closest('a[href]') === anchor ||
    findNearbyEmptyPositionTarget(anchor) === target
  )
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
    'TABLE',
    'UL',
  )
}

function isPotentialBodyTextElement(el: HTMLElement) {
  return isTagName(
    el,
    'BLOCKQUOTE',
    'DD',
    'DIV',
    'LI',
    'OL',
    'P',
    'SECTION',
    'TABLE',
    'UL',
  )
}

function isSemanticNoteSourceAnchor(anchor: HTMLAnchorElement) {
  return (
    hasKeywordToken(anchor.className, 'footnote', 'endnote', 'noteref') ||
    hasKeywordToken(
      anchor.getAttribute('role'),
      'doc-noteref',
      'noteref',
      'footnote',
      'endnote',
      'note',
    ) ||
    hasKeywordToken(
      anchor.getAttribute('epub:type') ?? anchor.getAttribute('type'),
      'noteref',
      'footnote',
      'endnote',
      'note',
    )
  )
}

function isSemanticNoteTarget(el: HTMLElement) {
  if (hasKeywordToken(el.className, 'footnote', 'endnote')) {
    return true
  }

  if (
    hasKeywordToken(
      el.getAttribute('role'),
      'doc-footnote',
      'doc-endnote',
      'doc-note',
      'note',
    )
  ) {
    return true
  }

  if (
    hasKeywordToken(
      el.getAttribute('epub:type') ?? el.getAttribute('type'),
      'footnote',
      'endnote',
      'rearnote',
      'note',
    )
  ) {
    return true
  }

  const parent = el.parentElement
  return !!parent && hasKeywordToken(parent.className, 'footnote', 'endnote')
}

function findNearbyEmptyPositionTarget(anchor: HTMLAnchorElement) {
  let cur: HTMLElement | null = anchor

  while (cur?.parentElement && cur.parentElement !== cur.ownerDocument.body) {
    const previous = cur.previousElementSibling
    if (isHTMLElement(previous) && isEmptyPositionTarget(previous)) {
      return previous
    }

    cur = cur.parentElement
    if (cur && isPotentialBodyTextElement(cur)) return
  }
}

function isEmptyPositionTarget(el: HTMLElement) {
  return (
    isTagName(el, 'A', 'SPAN') &&
    !!(el.id || el.getAttribute('name')) &&
    !el.textContent?.trim()
  )
}

function hasKeywordToken(
  value: string | null | undefined,
  ...keywords: string[]
) {
  if (!value) return false

  return value
    .toLowerCase()
    .split(/\s+/)
    .some((token) =>
      keywords.some(
        (keyword) =>
          token === keyword ||
          token.startsWith(`${keyword}-`) ||
          token.endsWith(`-${keyword}`) ||
          token.includes(`-${keyword}-`),
      ),
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

function uniqueElements<T extends HTMLElement>(elements: T[]) {
  return [...new Set(elements)]
}

function isElementNode(node: ChildNode | undefined) {
  return (
    node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
  )
}

function isHTMLElement(node: Element | null | undefined): node is HTMLElement {
  return (
    node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
  )
}

function isTagName(el: Element, ...names: string[]) {
  const tagName = el.tagName.toUpperCase()
  return names.some((name) => tagName === name)
}
