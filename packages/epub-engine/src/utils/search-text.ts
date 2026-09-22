import { findTextMatches } from './text-matches'

// These tags separate search runs regardless of their computed CSS display.
const blocks = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'div', 'dl',
  'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'td', 'th', 'tr', 'ul',
])
const ignored = new Set(['head', 'script', 'style', 'svg', 'math'])
const whitespace = /\p{White_Space}/u

export function chapterSearchQuery(keyword: string) {
  let start = 0
  let end = keyword.length
  while (start < end && whitespace.test(keyword[start]!)) start++
  while (end > start && whitespace.test(keyword[end - 1]!)) end--
  const query = keyword.slice(start, end)
  // Reject multiline queries; internal spaces and tabs remain literal.
  return /[\r\n]/.test(query) ? '' : query.toLowerCase()
}

interface SearchRun {
  text: string
  nodes: { node: Text; start: number; end: number }[]
}

/** Join inline text with UTF-16 node offsets; retain only the current run. */
export function* searchTextRuns(document: Document): Generator<SearchRun> {
  const root = document.body || document.documentElement
  let nodes: SearchRun['nodes'] = []
  let length = 0
  const flush = () => {
    const run = { text: nodes.map(({ node }) => node.data).join(''), nodes }
    nodes = []
    length = 0
    return run
  }
  let current: Node = root
  let entering = true
  // Flush on both entry and exit to separate text on either side of a block.
  while (true) {
    const name = current.nodeType === 1 ? (current as Element).localName : ''
    const block = blocks.has(name)
    if (entering) {
      if (block && nodes.length) yield flush()
      // CDATA is excluded: the CFI implementation only addresses Text nodes.
      if (current.nodeType === 3 && current.textContent) {
        const node = current as Text
        nodes.push({ node, start: length, end: length + node.length })
        length += node.length
      }
      if (!ignored.has(name) && current.firstChild) {
        current = current.firstChild
        continue
      }
    }
    if (block && nodes.length) yield flush()
    if (current === root) break
    if (current.nextSibling) {
      current = current.nextSibling
      entering = true
    } else {
      current = current.parentNode!
      entering = false
    }
  }
  if (nodes.length) yield flush()
}

export function* findRunMatches(document: Document, run: SearchRun, query: string) {
  let startIndex = 0
  let endIndex = 0
  for (const { start, end } of findTextMatches(run.text, query)) {
    while (run.nodes[startIndex]!.end <= start) startIndex++
    while (run.nodes[endIndex]!.end < end) endIndex++
    const first = run.nodes[startIndex]!
    const last = run.nodes[endIndex]!
    const range = document.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    const excerpt = run.text.length < 150
      ? run.text
      : `...${run.text.substring(start - 75, start + 75)}...`
    yield { range, excerpt }
  }
}

export function* findChapterRanges(document: Document, keyword: string) {
  const query = chapterSearchQuery(keyword)
  if (!query) return
  for (const run of searchTextRuns(document)) {
    yield* findRunMatches(document, run, query)
  }
}
