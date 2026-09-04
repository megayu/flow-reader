import EpubCFI from '../epubcfi'

// The sibling index belongs to one query over an unchanged document.
class SearchCFI extends EpubCFI {
  constructor(range, base, positions) {
    super()
    this.positions = positions
    Object.assign(this, this.fromRange(range, base))
  }

  position(node) {
    if (!this.positions.has(node)) {
      let elementIndex = 0
      let textIndex = 0
      for (let child of node.parentNode.childNodes) {
        if (child.nodeType === 1) this.positions.set(child, elementIndex++)
        else if (child.nodeType === 3) this.positions.set(child, textIndex++)
      }
    }
    return this.positions.get(node)
  }
}

export function yieldSearch() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function findChapterMatches(section, keyword, { signal, mapMatch = (match) => match } = {}) {
  const query = keyword.toLowerCase()
  const document = section.document
  if (!query || !document || signal?.aborted) return []
  const walker = document.createTreeWalker(document.body || document.documentElement, 4)
  const positions = new WeakMap()
  const matches = []
  let deadline = performance.now() + 8
  let node
  while ((node = walker.nextNode())) {
    if (signal?.aborted || section.document !== document) return []
    const original = node.textContent
    const text = original.toLowerCase()
    let offset = 0
    let pos
    while ((pos = text.indexOf(query, offset)) !== -1) {
      if (signal?.aborted || section.document !== document) return []
      const range = document.createRange()
      range.setStart(node, pos)
      range.setEnd(node, pos + query.length)
      const cfi = new SearchCFI(range, section.cfiBase, positions).toString()
      const excerpt = original.length < 150 ? original : `...${original.substring(pos - 75, pos + 75)}...`
      matches.push(mapMatch({ cfi, excerpt }))
      offset = pos + 1
      if (performance.now() >= deadline) {
        await yieldSearch()
        deadline = performance.now() + 8
      }
    }
    if (performance.now() >= deadline) {
      await yieldSearch()
      deadline = performance.now() + 8
    }
  }
  return signal?.aborted || section.document !== document ? [] : matches
}
