const NOTE_CIRCLED_MARKER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/
const NOTE_NUMBER_MARKER_CHARS = '0-9零〇一二三四五六七八九十壹贰貳叁參肆伍陆陸柒捌玖拾佰仟百千萬万億亿兩两廿卅卌'
const NOTE_NUMBER_MARKER_PATTERN = new RegExp(`^[${NOTE_NUMBER_MARKER_CHARS}]+$`)
const NOTE_MARKER_OPENERS = '([〔［（【〚〖'
const NOTE_MARKER_CLOSERS = ')]〕］）】〛〗'

export function isExplicitNoteLink(link: Pick<Element, 'getAttribute'>) {
  return link.getAttribute('data-type')?.trim().toLowerCase() === 'footnote'
}

export function hasNoteContainerSemantics(element: HTMLElement) {
  if (element.tagName.toUpperCase() === 'A' && element.getAttribute('href') !== null) return false
  return (
    hasDeclaredNoteSemantics(element) ||
    hasKeywordToken(element.className, 'footnote', 'endnote', 'footnotes', 'endnotes')
  )
}

export function hasDeclaredNoteSemantics(element: HTMLElement) {
  if (element.tagName.toUpperCase() === 'A' && element.getAttribute('href') !== null) return false
  const dataType = element.getAttribute('data-type')?.trim().toLowerCase()
  if (dataType === 'footnote' || dataType === 'endnote' || dataType === 'footnotes' || dataType === 'endnotes')
    return true

  if (
    hasToken(
      element.getAttribute('role'),
      'doc-footnote',
      'doc-endnote',
      'doc-note',
      'note',
      'doc-footnotes',
      'doc-endnotes',
    )
  ) {
    return true
  }

  if (
    hasToken(
      element.getAttribute('epub:type') ?? element.getAttribute('type'),
      'footnote',
      'endnote',
      'rearnote',
      'note',
      'footnotes',
      'endnotes',
    )
  ) {
    return true
  }

  return false
}

export function hasNoteCollectionSemantics(element: HTMLElement) {
  const dataType = element.getAttribute('data-type')?.trim().toLowerCase()
  if (dataType === 'footnotes' || dataType === 'endnotes') return true

  if (hasToken(element.getAttribute('role'), 'doc-footnotes', 'doc-endnotes')) return true

  if (hasToken(element.getAttribute('epub:type') ?? element.getAttribute('type'), 'footnotes', 'endnotes')) return true

  return hasKeywordToken(element.className, 'footnotes', 'endnotes')
}

export function isNoteMarkerText(text: string | null | undefined) {
  const marker = (text ?? '').trim()
  if (!marker) return false
  if (/^[*＊]+$/.test(marker)) return true
  if (NOTE_CIRCLED_MARKER_PATTERN.test(marker)) return true

  const normalized = stripNoteMarkerWrapper(marker)
  return NOTE_NUMBER_MARKER_PATTERN.test(normalized)
}

function stripNoteMarkerWrapper(text: string) {
  let marker = text.trim()

  if (NOTE_MARKER_OPENERS.includes(marker[0] ?? '')) {
    marker = marker.slice(1)
  }
  if (NOTE_MARKER_CLOSERS.includes(marker[marker.length - 1] ?? '')) {
    marker = marker.slice(0, -1)
  }

  return marker.trim()
}

export function hasToken(value: string | null | undefined, ...tokens: string[]) {
  if (!value) return false

  const normalized = value.toLowerCase().split(/\s+/)
  return tokens.some((token) => normalized.includes(token))
}

function hasKeywordToken(value: string | null | undefined, ...keywords: string[]) {
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
