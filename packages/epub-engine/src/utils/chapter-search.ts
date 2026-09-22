import type Section from '../section'

export interface ChapterSearchMatch {
  cfi: string
  excerpt: string
}
export interface ChapterSearchOptions<Result = ChapterSearchMatch> {
  signal?: AbortSignal
  mapMatch?: (match: ChapterSearchMatch) => Result
}

import EpubCFI from '../epubcfi'
import { chapterSearchQuery, findRunMatches, searchTextRuns } from './search-text'

// The sibling index belongs to one query over an unchanged document.
class SearchCFI extends EpubCFI {
  declare positions: WeakMap<Node, number>
  constructor(range: Range, base: string, positions: WeakMap<Node, number>) {
    super()
    this.positions = positions
    Object.assign(this, this.fromRange(range, base))
  }

  position(node: Node) {
    if (!this.positions.has(node)) {
      let elementIndex = 0
      let textIndex = 0
      for (let child of node.parentNode!.childNodes) {
        if (child.nodeType === 1) this.positions.set(child, elementIndex++)
        else if (child.nodeType === 3) this.positions.set(child, textIndex++)
      }
    }
    return this.positions.get(node)!
  }
}

export function yieldSearch() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export function findChapterMatches(
  section: Section,
  keyword: string,
  options?: ChapterSearchOptions,
): Promise<ChapterSearchMatch[]>
export function findChapterMatches<Result>(
  section: Section,
  keyword: string,
  options: ChapterSearchOptions<Result> & {
    mapMatch: (match: ChapterSearchMatch) => Result
  },
): Promise<Result[]>
export function findChapterMatches(
  section: Section,
  keyword: string,
  options?: ChapterSearchOptions<unknown>,
): Promise<unknown[]>
export async function findChapterMatches(
  section: Section,
  keyword: string,
  { signal, mapMatch = (match) => match }: ChapterSearchOptions<unknown> = {},
) {
  const query = chapterSearchQuery(keyword)
  const document = section.document
  if (!query || !document || signal?.aborted) return []
  const positions = new WeakMap<Node, number>()
  const matches = []
  let deadline = performance.now() + 8
  // Yield between runs and matches; building a single run is synchronous.
  for (const run of searchTextRuns(document)) {
    if (signal?.aborted || section.document !== document) return []
    for (const { range, excerpt } of findRunMatches(document, run, query)) {
      if (signal?.aborted || section.document !== document) return []
      const cfi = new SearchCFI(range, section.cfiBase, positions).toString()
      matches.push(mapMatch({ cfi, excerpt }))
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
