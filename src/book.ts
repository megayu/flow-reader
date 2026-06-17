import { BookRecord } from './db'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function cleanBookText(value?: string) {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

export function stripFileExtension(filename: string) {
  return cleanBookText(filename).replace(/\.[^.]+$/, '')
}

export function getBookDisplayTitle(book: BookRecord) {
  return cleanBookText(book.metadata.title) || stripFileExtension(book.name)
}

export function compareBookDisplayTitle(a: BookRecord, b: BookRecord) {
  const title = collator.compare(getBookDisplayTitle(a), getBookDisplayTitle(b))
  if (title) return title

  return collator.compare(cleanBookText(a.name), cleanBookText(b.name))
}

export function getBookTooltip(book: BookRecord) {
  return [
    cleanBookText(book.metadata.title),
    cleanBookText(book.metadata.creator),
    cleanBookText(book.name),
  ]
    .filter(Boolean)
    .join('\n')
}
