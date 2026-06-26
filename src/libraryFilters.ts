import { cleanBookText } from './book'
import type { BookRecord, ReadingStatus } from './db'

const authorCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export interface LibraryAuthorOption {
  name: string
  pinned: boolean
}

export function getBookAuthor(book: BookRecord) {
  return cleanBookText(book.metadata.creator)
}

export function matchesLibraryStatusFilter(
  book: BookRecord,
  statusFilters: ReadingStatus[],
) {
  if (!statusFilters.length) return true

  return !!book.readingStatus && statusFilters.includes(book.readingStatus)
}

export function filterBooksByLibraryFilters(
  books: BookRecord[],
  statusFilters: ReadingStatus[],
  authorFilters: string[],
) {
  const authors = new Set(authorFilters)

  return books.filter((book) => {
    if (!matchesLibraryStatusFilter(book, statusFilters)) return false
    if (!authors.size) return true

    return authors.has(getBookAuthor(book))
  })
}

export function getLibraryAuthorOptions(
  books: BookRecord[],
  statusFilters: ReadingStatus[],
  pinnedAuthors: string[] = [],
): LibraryAuthorOption[] {
  const authorNames = new Set<string>()

  books.forEach((book) => {
    if (!matchesLibraryStatusFilter(book, statusFilters)) return

    const author = getBookAuthor(book)
    if (author) authorNames.add(author)
  })

  const sortedAuthors = Array.from(authorNames).sort((a, b) =>
    authorCollator.compare(a, b),
  )
  const availableAuthors = new Set(sortedAuthors)
  const pinned = uniqueStrings(pinnedAuthors).filter((author) =>
    availableAuthors.has(author),
  )
  const pinnedSet = new Set(pinned)

  return [
    ...pinned.map((name) => ({ name, pinned: true })),
    ...sortedAuthors
      .filter((name) => !pinnedSet.has(name))
      .map((name) => ({ name, pinned: false })),
  ]
}

export function pruneLibraryAuthorFilters(
  authorFilters: string[],
  authorOptions: LibraryAuthorOption[],
) {
  const availableAuthors = new Set(authorOptions.map((option) => option.name))

  return uniqueStrings(authorFilters).filter((author) =>
    availableAuthors.has(author),
  )
}

export function toggleLibraryAuthorFilter(
  authorFilters: string[],
  author: string,
) {
  return authorFilters.includes(author)
    ? authorFilters.filter((item) => item !== author)
    : [...authorFilters, author]
}

export function pinLibraryAuthor(pinnedAuthors: string[], author: string) {
  return [
    author,
    ...uniqueStrings(pinnedAuthors).filter((item) => item !== author),
  ]
}

export function unpinLibraryAuthor(pinnedAuthors: string[], author: string) {
  return uniqueStrings(pinnedAuthors).filter((item) => item !== author)
}

export function areStringListsEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []

  values.forEach((value) => {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) return

    seen.add(normalized)
    result.push(normalized)
  })

  return result
}
