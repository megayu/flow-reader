import { isSupportedExternalUrl } from '../../externalLink'
import { hasNoteContainerSemantics, isNoteMarkerText } from '../../noteSemantics'

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

export function cloneNoteElement(
  el: HTMLElement,
  writingMode: string,
  anchor: HTMLAnchorElement,
  resolveBookLink: (link: HTMLAnchorElement) => string | undefined,
) {
  // Copy directly from the source document while its computed styles and link base are available.
  const copyNode = (source: Node): Node => {
    if (source.nodeType !== 1) return source.cloneNode(false)
    const element = source as HTMLElement
    if (NOTE_POPOVER_BLOCKED_ELEMENTS.has(element.tagName.toUpperCase())) {
      return element.ownerDocument.createTextNode('')
    }
    const target = element.cloneNode(false) as HTMLElement
    sanitizeNotePopoverElement(target)
    copyNoteTextStyles(element, target)
    copyNoteImage(element, target)
    if (element.tagName.toUpperCase() === 'A') {
      const link = element as HTMLAnchorElement
      const href = link.getAttribute('href')?.trim()
      if (href && isSupportedExternalUrl(href)) {
        target.setAttribute('href', href)
      } else if (!isBacklink(link, anchor)) {
        const destination = resolveBookLink(link)
        if (destination) target.setAttribute('href', destination)
      }
    }
    for (const child of element.childNodes) target.appendChild(copyNode(child))
    return target
  }
  const segment = getSegmentedNote(el, anchor)
  let clone: HTMLElement
  if (segment) {
    clone = el.ownerDocument.createElement('div')
    copyNoteTextStyles(segment.container, clone)
    for (const node of segment.nodes) clone.appendChild(copyNode(node))
  } else {
    const copied = copyNode(el)
    clone = copied.nodeType === 1 ? (copied as HTMLElement) : el.ownerDocument.createElement('span')
  }
  normalizeNotePopoverOuterSpacing(clone, writingMode)
  if (clone.style.display === 'none') clone.style.setProperty('display', 'block', 'important')
  if (clone.tagName === 'LI') clone.style.setProperty('display', 'block', 'important')
  applyNotePopoverWritingMode(clone, writingMode)

  return clone
}

function isEmptyPositionTarget(el: HTMLElement) {
  return isTagName(el, 'A', 'SPAN') && !!(el.id || el.getAttribute('name')) && !el.textContent?.trim()
}

function getSegmentedNote(target: HTMLElement, anchor: HTMLAnchorElement) {
  const container = findNoteContainer(target)
  const marker = target.closest('a[href]') as HTMLAnchorElement | null
  if (!container || !marker || !isBacklink(marker, anchor)) return

  const markerChild = getDirectChild(container, marker)
  if (!markerChild || !hasMultipleNoteMarkers(container)) return

  const nodes: ChildNode[] = []
  let node: ChildNode | null = markerChild
  while (node) {
    if (node !== markerChild && startsWithNoteMarker(node)) break

    nodes.push(node)
    node = node.nextSibling
  }

  return { container, nodes }
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

  return isTagName(el, 'ASIDE') || hasNoteContainerSemantics(el)
}

function isInlineNoteMarker(el: HTMLElement) {
  return isTagName(el, 'A', 'SPAN', 'SUP', 'SUB') && isNoteMarkerText(el.textContent)
}

function isTagName(el: Element, ...names: string[]) {
  const tagName = el.tagName.toUpperCase()
  return names.some((name) => tagName === name)
}

function normalizeNotePopoverOuterSpacing(root: HTMLElement, writingMode?: string) {
  root.style.setProperty('margin', '0', 'important')
  root.style.setProperty('padding', '0', 'important')

  const vertical = writingMode === 'vertical-rl'
  for (const child of root.children as HTMLCollectionOf<HTMLElement>) {
    child.style.setProperty(vertical ? 'margin-top' : 'margin-left', '0', 'important')
    child.style.setProperty(vertical ? 'margin-bottom' : 'margin-right', '0', 'important')
  }
  trimNotePopoverBoundaryMargin(root, 'first', vertical ? 'margin-right' : 'margin-top')
  trimNotePopoverBoundaryMargin(root, 'last', vertical ? 'margin-left' : 'margin-bottom')
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

function copyNoteImage(source: HTMLElement, target: HTMLElement) {
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
