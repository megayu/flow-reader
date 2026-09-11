import type { BookRecord } from './storage'

export type BookPresentation = Pick<BookRecord, 'name' | 'metadata' | 'scope' | 'archive' | 'editable'>

export type BookTooltipLineKind = 'creator' | 'file' | 'title'

export interface BookTooltipLine {
  kind: BookTooltipLineKind
  text: string
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function cleanBookText(value?: string | null) {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

export function stripFileExtension(filename: string) {
  return cleanBookText(filename).replace(/\.[^.]+$/, '')
}

export function getBookDisplayTitle(book: BookPresentation) {
  return cleanBookText(book.metadata.title) || stripFileExtension(book.name)
}

export function compareBookDisplayTitle(a: BookRecord, b: BookRecord) {
  const title = collator.compare(getBookDisplayTitle(a), getBookDisplayTitle(b))
  if (title) return title

  return collator.compare(cleanBookText(a.name), cleanBookText(b.name))
}

export function getBookTooltip(book: BookPresentation) {
  return getBookTooltipLines(book)
    .map((line) => line.text)
    .join('\n')
}

export function getBookTooltipLines(book: BookPresentation): BookTooltipLine[] {
  const lines: BookTooltipLine[] = [
    { kind: 'title', text: cleanBookText(book.metadata.title) },
    { kind: 'creator', text: cleanBookText(book.metadata.creator) },
    { kind: 'file', text: cleanBookText(book.name) },
  ]

  return lines.filter((line) => Boolean(line.text))
}
