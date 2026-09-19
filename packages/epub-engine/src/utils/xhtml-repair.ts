/** Remove only unmatched end tags inside a body; leave ambiguous structures alone. */
export function repairOrphanClosingTags(markup: string) {
  const stack: string[] = []
  const openCounts = new Map<string, number>()
  const pieces: string[] = []
  let copied = 0
  let cursor = 0

  while (cursor < markup.length) {
    const start = markup.indexOf('<', cursor)
    if (start < 0) break

    const terminator = markup.startsWith('<!--', start)
      ? '-->'
      : markup.startsWith('<![CDATA[', start)
        ? ']]>'
        : markup.startsWith('<?', start)
          ? '?>'
          : undefined
    if (terminator) {
      const end = markup.indexOf(terminator, start + 2)
      if (end < 0) return markup
      cursor = end + terminator.length
      continue
    }

    let quote = ''
    let end = start + 1
    const declaration = markup.startsWith('<!', start)
    for (; end < markup.length; end++) {
      const char = markup[end]!
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      } else if (char === '<' || (declaration && char === '[')) {
        // Internal DTD subsets require a different grammar; do not repair them.
        return markup
      }
    }
    if (end === markup.length) return markup
    cursor = end + 1
    if (declaration) continue

    const tag = markup.slice(start, cursor)
    const name = /^<\/?([A-Za-z_][\w.:-]*)(?=[\s/>])/.exec(tag)?.[1]
    if (!name) return markup

    if (tag.startsWith('</')) {
      if (!/^<\/[A-Za-z_][\w.:-]*\s*>$/.test(tag)) return markup
      if (stack[stack.length - 1] === name) {
        stack.pop()
        const count = openCounts.get(name)! - 1
        if (count) openCounts.set(name, count)
        else openCounts.delete(name)
      } else if (
        !openCounts.has(name) &&
        openCounts.has('body') &&
        name !== 'head' &&
        name !== 'html'
      ) {
        pieces.push(markup.slice(copied, start))
        copied = cursor
      } else {
        return markup
      }
    } else if (!tag.endsWith('/>')) {
      stack.push(name)
      openCounts.set(name, (openCounts.get(name) ?? 0) + 1)
    }
  }

  if (!pieces.length || stack.length) return markup
  pieces.push(markup.slice(copied))
  return pieces.join('')
}
