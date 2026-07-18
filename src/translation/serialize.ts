export function joinTranslationSections(sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function splitTranslationSections(text: string): string[] {
  return text
    .split(/\n{2,}/u)
    .map((section) => section.trim())
    .filter(Boolean)
}

const LINE_BREAK_ELEMENTS = new Set([
  'ADDRESS',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'P',
  'PRE',
])

const SECTION_BREAK_ELEMENTS = new Set(['ARTICLE', 'SECTION'])

export function serializeTranslationFragment(
  fragment: DocumentFragment,
): string {
  let text = ''
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.childNodes.forEach(visit)
      return
    }
    const element = node as Element
    if (element.tagName === 'BR') {
      text += '\n'
      return
    }
    node.childNodes.forEach(visit)
    if (SECTION_BREAK_ELEMENTS.has(element.tagName)) text += '\n\n'
    else if (LINE_BREAK_ELEMENTS.has(element.tagName)) text += '\n'
  }
  fragment.childNodes.forEach(visit)
  return text
    .replace(/[\t ]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}
