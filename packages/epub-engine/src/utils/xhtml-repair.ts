const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

interface MarkupToken {
  start: number
  end: number
  tag: boolean
}

// Advance monotonically so long text runs and malformed input stay linear.
// Comments, CDATA, processing instructions and declarations are opaque.
function* markupTokens(markup: string): Generator<MarkupToken> {
  let cursor = 0
  while (cursor < markup.length) {
    const start = markup.indexOf('<', cursor)
    if (start < 0) return

    let terminator: string | undefined
    if (markup.startsWith('<!--', start)) terminator = '-->'
    else if (markup.startsWith('<![CDATA[', start)) terminator = ']]>'
    else if (markup.startsWith('<?', start)) terminator = '?>'
    if (terminator) {
      const end = markup.indexOf(terminator, start + 2)
      cursor = end < 0 ? markup.length : end + terminator.length
      yield { start, end: cursor, tag: false }
      continue
    }

    const declaration = markup.startsWith('<!', start)
    let quote = ''
    let subsetDepth = 0
    let end = start + 1
    for (; end < markup.length; end++) {
      const char = markup[end]!
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (declaration && markup.startsWith('<!--', end)) {
        const commentEnd = markup.indexOf('-->', end + 4)
        if (commentEnd < 0) break
        end = commentEnd + 2
      } else if (declaration && char === '[') {
        subsetDepth++
      } else if (declaration && char === ']') {
        subsetDepth--
      } else if (char === '>' && subsetDepth === 0) {
        break
      } else if (!declaration && char === '<') {
        break
      }
    }
    if (markup[end] !== '>') {
      yield { start, end: markup.length, tag: false }
      return
    }
    cursor = end + 1
    yield { start, end: cursor, tag: !declaration }
  }
}

function tagAttributes(tag: string, name: string) {
  const attributes = new Map<string, string>()
  const attribute = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
  let cursor = name.length + 1
  while (cursor < tag.length) {
    while (/\s/.test(tag[cursor] ?? '')) cursor++
    if (tag[cursor] === '>' || tag.startsWith('/>', cursor)) return attributes
    attribute.lastIndex = cursor
    const match = attribute.exec(tag)
    if (!match) return undefined
    attributes.set(match[1]!, match[2] ?? match[3]!)
    cursor = attribute.lastIndex
  }
  return undefined
}

const commonHtmlEntities = new Map([
  ['nbsp', '&#160;'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['hellip', '…'],
  ['copy', '©'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
])

export function repairXmlEntities(markup: string) {
  if (!markup.includes('&')) return markup
  // DTDs can give even familiar entity names an authored meaning.
  const replaceNamed = !/<!DOCTYPE\b/i.test(markup)
  const repair = (text: string) => text.replace(
    /&(?:#\d+;|#x[\da-fA-F]+;|[^\s<>&;]+;)?/g,
    (reference) => reference === '&'
      ? '&amp;'
      : (replaceNamed && commonHtmlEntities.get(reference.slice(1, -1))) || reference,
  )
  const pieces: string[] = []
  let cursor = 0
  for (const token of markupTokens(markup)) {
    pieces.push(repair(markup.slice(cursor, token.start)))
    const text = markup.slice(token.start, token.end)
    pieces.push(token.tag ? repair(text) : text)
    cursor = token.end
  }
  pieces.push(repair(markup.slice(cursor)))
  return pieces.join('')
}

export function repairUndeclaredXlinkNamespace(markup: string) {
  if (!markup.includes('xlink:href')) return markup
  let rootEnd: number | undefined
  let usesXlink = false
  for (const token of markupTokens(markup)) {
    if (!token.tag) continue
    const tag = markup.slice(token.start, token.end)
    if (tag.startsWith('</')) continue
    const name = /^<([A-Za-z_][\w.:-]*)(?=[\s/>])/.exec(tag)?.[1]
    if (!name) return markup
    const attributes = tagAttributes(tag, name)
    if (!attributes || attributes.has('xmlns:xlink')) return markup
    if (rootEnd === undefined) {
      if (name !== 'html' || tag.endsWith('/>')) return markup
      rootEnd = token.end - 1
    }
    usesXlink ||= attributes.has('xlink:href')
  }
  if (!usesXlink || rootEnd === undefined) return markup
  return markup.slice(0, rootEnd)
    + ' xmlns:xlink="http://www.w3.org/1999/xlink"'
    + markup.slice(rootEnd)
}

const htmlVoidElements = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

interface RepairEdit {
  start: number
  end: number
  replacement: string
  enabled: boolean
}

/** Repair known empty HTML elements and unmatched end tags without guessing nesting. */
export function repairXhtmlTags(markup: string) {
  const stack: { name: string; namespace: string; voidEdit?: RepairEdit }[] = []
  const openCounts = new Map<string, number>()
  const edits: RepairEdit[] = []
  const pop = () => {
    const element = stack.pop()!
    const count = openCounts.get(element.name)! - 1
    if (count) openCounts.set(element.name, count)
    else openCounts.delete(element.name)
    return element
  }

  for (const token of markupTokens(markup)) {
    if (!token.tag) continue
    const tag = markup.slice(token.start, token.end)
    const name = /^<\/?([A-Za-z_][\w.:-]*)(?=[\s/>])/.exec(tag)?.[1]
    if (!name) return markup

    if (tag.startsWith('</')) {
      if (!/^<\/[A-Za-z_][\w.:-]*\s*>$/.test(tag)) return markup
      while (openCounts.has(name) && stack.at(-1)?.name !== name && stack.at(-1)?.voidEdit) pop()
      if (stack.at(-1)?.name === name) {
        const element = pop()
        // An authored matching end tag takes precedence over HTML void semantics.
        if (element.voidEdit) element.voidEdit.enabled = false
      } else if (
        !openCounts.has(name) && openCounts.has('body')
        && name !== 'head' && name !== 'html'
      ) {
        edits.push({ start: token.start, end: token.end, replacement: '', enabled: true })
      } else {
        return markup
      }
    } else if (!tag.endsWith('/>')) {
      const attributes = tagAttributes(tag, name)
      if (!attributes) return markup
      const namespace = attributes.get('xmlns') ?? stack.at(-1)?.namespace ?? ''
      let voidEdit: RepairEdit | undefined
      if (namespace === XHTML_NAMESPACE && htmlVoidElements.has(name)) {
        voidEdit = { start: token.end - 1, end: token.end - 1, replacement: '/', enabled: true }
        edits.push(voidEdit)
      }
      stack.push({ name, namespace, voidEdit })
      openCounts.set(name, (openCounts.get(name) ?? 0) + 1)
    }
  }

  if (!edits.length || stack.length) return markup
  const pieces: string[] = []
  let copied = 0
  for (const edit of edits) {
    if (!edit.enabled) continue
    pieces.push(markup.slice(copied, edit.start), edit.replacement)
    copied = edit.end
  }
  pieces.push(markup.slice(copied))
  return pieces.join('')
}
