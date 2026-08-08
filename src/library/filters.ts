import { cleanBookText } from '../book'
import type { BookRecord, LibraryTagRecord, ReadingStatus } from '../storage'

const authorCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export interface LibraryAuthorOption {
  name: string
  pinned: boolean
}

export interface LibraryTagOption {
  id: string
  name: string
  pinned: boolean
}

export function getBookAuthor(book: BookRecord) {
  return cleanBookText(book.metadata.creator)
}

export function cleanLibraryTagName(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

export function sameLibraryTagName(a: string, b: string) {
  return cleanLibraryTagName(a).toLocaleLowerCase() === cleanLibraryTagName(b).toLocaleLowerCase()
}

export function orderLibraryTags(tags: LibraryTagRecord[], pinnedTags: string[] = []) {
  const sortedTags = [...tags].sort((a, b) => authorCollator.compare(a.name, b.name))
  const tagById = new Map(sortedTags.map((tag) => [tag.id, tag]))
  const pinned = uniqueStrings(pinnedTags).filter((tagId) => tagById.has(tagId))
  const pinnedSet = new Set(pinned)

  return [...pinned.map((tagId) => tagById.get(tagId)!), ...sortedTags.filter((tag) => !pinnedSet.has(tag.id))]
}

export function matchesLibraryStatusFilter(book: BookRecord, statusFilters: ReadingStatus[]) {
  if (!statusFilters.length) return true

  return !!book.readingStatus && statusFilters.includes(book.readingStatus)
}

export function filterBooksByLibraryFilters(
  books: BookRecord[],
  statusFilters: ReadingStatus[],
  authorFilters: string[],
  tagFilters: string[] = [],
) {
  const authors = new Set(authorFilters)
  const tags = new Set(tagFilters)

  return books.filter((book) => {
    if (!matchesLibraryStatusFilter(book, statusFilters)) return false
    if (authors.size && !authors.has(getBookAuthor(book))) return false
    if (!tags.size) return true

    return (book.tagIds ?? []).some((tagId) => tags.has(tagId))
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

  const sortedAuthors = Array.from(authorNames).sort((a, b) => authorCollator.compare(a, b))
  const availableAuthors = new Set(sortedAuthors)
  const pinned = uniqueStrings(pinnedAuthors).filter((author) => availableAuthors.has(author))
  const pinnedSet = new Set(pinned)

  const options = pinned.map((name) => ({ name, pinned: true }))
  for (const name of sortedAuthors) {
    if (!pinnedSet.has(name)) options.push({ name, pinned: false })
  }
  return options
}

export function pruneLibraryAuthorFilters(authorFilters: string[], authorOptions: LibraryAuthorOption[]) {
  const availableAuthors = new Set(authorOptions.map((option) => option.name))

  return uniqueStrings(authorFilters).filter((author) => availableAuthors.has(author))
}

export function getLibraryTagOptions(
  books: BookRecord[],
  statusFilters: ReadingStatus[],
  tags: LibraryTagRecord[],
  pinnedTags: string[] = [],
): LibraryTagOption[] {
  const availableTagIds = new Set<string>(statusFilters.length ? [] : tags.map((tag) => tag.id))
  const tagById = new Map(tags.map((tag) => [tag.id, tag]))

  books.forEach((book) => {
    if (!matchesLibraryStatusFilter(book, statusFilters)) return
    ;(book.tagIds ?? []).forEach((tagId) => {
      if (tagById.has(tagId)) availableTagIds.add(tagId)
    })
  })

  const pinnedSet = new Set(uniqueStrings(pinnedTags))

  return orderLibraryTags(
    Array.from(availableTagIds).map((tagId) => tagById.get(tagId)!),
    pinnedTags,
  ).map((tag) => ({ id: tag.id, name: tag.name, pinned: pinnedSet.has(tag.id) }))
}

export function pruneLibraryTagFilters(tagFilters: string[], tagOptions: LibraryTagOption[]) {
  const availableTags = new Set(tagOptions.map((option) => option.id))

  return uniqueStrings(tagFilters).filter((tagId) => availableTags.has(tagId))
}

export function toggleLibraryAuthorFilter(authorFilters: string[], author: string) {
  return authorFilters.includes(author) ? authorFilters.filter((item) => item !== author) : [...authorFilters, author]
}

export function toggleLibraryTagFilter(tagFilters: string[], tagId: string) {
  return tagFilters.includes(tagId) ? tagFilters.filter((item) => item !== tagId) : [...tagFilters, tagId]
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
