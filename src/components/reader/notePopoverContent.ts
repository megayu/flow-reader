import { isSupportedExternalUrl } from '../../externalLink'
import { hasNoteContainerSemantics, hasToken, isNoteMarkerText } from '../../noteSemantics'

const blockedElements = 'base, embed, iframe, link, meta, object, script, style'
const blockedAttributes = new Set([
  'action',
  'formaction',
  'ping',
  'srcdoc',
  'autofocus',
  'id',
  'name',
  'srcset',
  'xlink:href',
])

export function cloneNoteElement(
  source: HTMLElement,
  resolveBookLink: (link: HTMLAnchorElement) => string | undefined,
  noteTarget?: string,
) {
  const segment = getSegmentedNote(source)
  let clone: HTMLElement
  if (segment) {
    const range = source.ownerDocument.createRange()
    range.setStartBefore(segment[0]!)
    range.setEndAfter(segment.at(-1)!)
    clone = source.ownerDocument.createElement('div')
    clone.appendChild(range.cloneContents())
  } else {
    clone = source.cloneNode(true) as HTMLElement
  }

  const links = clone.matches('a[href]')
    ? [clone as HTMLAnchorElement, ...clone.querySelectorAll<HTMLAnchorElement>('a[href]')]
    : [...clone.querySelectorAll<HTMLAnchorElement>('a[href]')]
  // The note has already been identified. Its leading return entry and declared
  // backlinks use the note destination, independent of the clicked reference.
  const returnHrefs = new Set(
    links
      .filter((link, index) => (index === 0 && isLeadingNoteLink(clone, link)) || isDeclaredBacklink(link))
      .map((link) => link.getAttribute('href')?.trim())
      .filter((href): href is string => !!href && href.includes('#')),
  )

  // Preserve classes and inline styles; the clone uses the referring chapter's stylesheet.
  // Sanitize active content and resolve links before inserting it into the reader document.
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    if (element.matches(blockedElements)) {
      if (element === clone) return source.ownerDocument.createElement('span')
      element.remove()
      continue
    }
    element.style.setProperty('text-indent', '0', 'important')
    if (element.localName === 'a') {
      const link = element as HTMLAnchorElement
      const href = link.getAttribute('href')?.trim()
      let destination: string | undefined
      if (href && isSupportedExternalUrl(href)) destination = href
      else if (isDeclaredBacklink(link) || (href && returnHrefs.has(href))) {
        // Open the original endnote when visible; leave backlinks disabled when hidden.
        destination = noteTarget
      } else {
        // Ordinary book links keep their own destinations.
        destination = resolveBookLink(link)
      }
      element.removeAttribute('href')
      if (destination) element.setAttribute('href', destination)
    }
    if (element.localName === 'img') {
      const image = element as HTMLImageElement
      const src = image.getAttribute('src')
      if (src) {
        try {
          const resolved = new URL(src, source.ownerDocument.baseURI).href
          if (/^(https?:|blob:|data:image\/|(?:epub|asset):\/\/localhost\/)/i.test(resolved)) image.src = resolved
          else image.removeAttribute('src')
        } catch {
          image.removeAttribute('src')
        }
      }
    }
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on') || blockedAttributes.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  clone.removeAttribute('hidden')
  clone.style.setProperty('display', 'block', 'important')
  trimBoundaryMargin(clone, 'start')
  trimBoundaryMargin(clone, 'end')
  return clone
}

function isLeadingNoteLink(root: HTMLElement, link: HTMLAnchorElement) {
  if (root === link) return true
  const range = root.ownerDocument.createRange()
  range.selectNodeContents(root)
  range.setEndBefore(link)
  const prefix = range.toString().trim()
  // Allow a note-number wrapper before the link, but not preceding note prose.
  return !prefix || isNoteMarkerText(prefix + link.textContent)
}

function trimBoundaryMargin(root: HTMLElement, edge: 'start' | 'end') {
  let element: HTMLElement | undefined = root
  while (element) {
    element.style.setProperty(`margin-block-${edge}`, '0', 'important')
    const children: ChildNode[] = Array.from(element.childNodes)
    const boundary = (edge === 'start' ? children : children.reverse()).find(
      (node) => node.nodeType === 1 || (node.nodeType === 3 && !!node.textContent?.trim()),
    )
    element = boundary?.nodeType === 1 ? (boundary as HTMLElement) : undefined
  }
}

function getSegmentedNote(target: HTMLElement) {
  const container = findNoteContainer(target)
  const marker = target.closest('a[href]') as HTMLAnchorElement | null
  if (!container || !marker) return

  const markerChild = getDirectChild(container, marker)
  if (!markerChild || !hasMultipleNoteMarkers(container)) return

  const nodes: ChildNode[] = []
  let node: ChildNode | null = markerChild
  while (node) {
    if (node !== markerChild && startsWithNoteMarker(node)) break

    nodes.push(node)
    node = node.nextSibling
  }

  return nodes
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

function isDeclaredBacklink(link: HTMLAnchorElement) {
  return (
    hasToken(link.getAttribute('role'), 'doc-backlink', 'backlink') ||
    hasToken(link.getAttribute('epub:type') ?? link.getAttribute('type'), 'doc-backlink', 'backlink')
  )
}
