const NOTE_CIRCLED_MARKER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/
const NOTE_NUMBER_MARKER_CHARS =
  '0-9零〇一二三四五六七八九十壹贰貳叁參肆伍陆陸柒捌玖拾佰仟百千萬万億亿兩两廿卅卌'
const NOTE_NUMBER_MARKER_PATTERN = new RegExp(
  `^[${NOTE_NUMBER_MARKER_CHARS}]+$`,
)
const NOTE_NUMBER_MARKER_PREFIX_PATTERN = new RegExp(
  `^[${NOTE_NUMBER_MARKER_CHARS}]+[.．、]`,
)
const NOTE_MARKER_OPENERS = '([〔［（【〚〖'
const NOTE_MARKER_CLOSERS = ')]〕］）】〛〗'

export const NOTE_CONTAINER_PATTERN =
  /(?:footnote|endnote|rearnote|noteref|note|annotation|comment|reference|fn|ftn)/i

export const noteContentAttributeSelectors = [
  '[role="doc-footnote"]',
  '[role="doc-footnotes"]',
  '[role="doc-endnote"]',
  '[role="doc-endnotes"]',
  '[role="doc-note"]',
  '[role="doc-notes"]',
  '[role="note"]',
  '[epub\\:type*="footnote"]',
  '[epub\\:type*="footnotes"]',
  '[epub\\:type*="endnote"]',
  '[epub\\:type*="endnotes"]',
  '[epub\\:type*="rearnote"]',
  '[epub\\:type*="rearnotes"]',
  '[epub\\:type*="note"]',
  '[epub\\:type*="notes"]',
  '[epub\\:type*="annotation"]',
  '[epub\\:type*="comment"]',
  '[epub\\:type*="reference"]',
  '[type*="footnote"]',
  '[type*="footnotes"]',
  '[type*="endnote"]',
  '[type*="endnotes"]',
  '[type*="rearnote"]',
  '[type*="rearnotes"]',
  '[type*="note"]',
  '[type*="notes"]',
  '[type*="annotation"]',
  '[type*="comment"]',
  '[type*="reference"]',
  '[class*="note" i]',
  '[class*="annotation" i]',
  '[class*="comment" i]',
  '[class*="reference" i]',
  '[id*="note" i]',
  '[id*="annotation" i]',
  '[id*="comment" i]',
  '[id*="reference" i]',
]

export const noteContentContainerSelector =
  noteContentAttributeSelectors.join(',\n')

const noteContentBlockTags = [
  'aside',
  'section',
  'div',
  'ol',
  'ul',
  'li',
  'dl',
  'dt',
  'dd',
  'p',
]

export const noteContentBlockSelector =
  createNoteContentBlockSelectors().join(',\n')

export function createNoteContentBlockSelectors() {
  return [
    `:is(${noteContentBlockTags.join(', ')}):is(${noteContentAttributeSelectors.join(', ')})`,
  ]
}

export function createHiddenNoteContentSelector(excludedClass: string) {
  const selectors = createNoteContentBlockSelectors()

  return [
    ...selectors.map((selector) => `body > ${selector}`),
    ...selectors.map(
      (selector) => `body > :not(.${excludedClass}) ${selector}`,
    ),
  ].join(',\n')
}

export function isNoteMarkerText(text: string | null | undefined) {
  const marker = (text ?? '').trim()
  if (!marker) return false
  if (/^[*＊]+$/.test(marker)) return true
  if (NOTE_CIRCLED_MARKER_PATTERN.test(marker)) return true

  const normalized = stripNoteMarkerWrapper(marker)
  return NOTE_NUMBER_MARKER_PATTERN.test(normalized)
}

export function startsWithNoteMarkerText(text: string | null | undefined) {
  const marker = (text ?? '').trim()
  if (!marker) return false
  if (isNoteMarkerText(marker)) return true

  const firstToken = marker.split(/\s+/)[0]
  if (isNoteMarkerText(firstToken)) return true

  const firstChar = Array.from(marker)[0]
  if (isNoteMarkerText(firstChar)) return true

  return NOTE_NUMBER_MARKER_PREFIX_PATTERN.test(marker)
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
