import type { BookRecord } from './types'

const readingActivityFields = new Set<keyof BookRecord>(['cfi', 'percentage', 'lastReadAt', 'configuration'])

function withoutReadingSpread(configuration: BookRecord['configuration'] | undefined) {
  const { spread, ...rest } = configuration ?? {}
  return rest
}

function isSpreadOnlyConfigurationUpdate(changes: Partial<BookRecord>, currentBook?: BookRecord) {
  if (!('configuration' in changes)) return true
  if (!currentBook) return false

  return (
    JSON.stringify(withoutReadingSpread(changes.configuration)) ===
    JSON.stringify(withoutReadingSpread(currentBook.configuration))
  )
}

function hasOnlyReadingActivityFields(changes: Partial<BookRecord>, currentBook?: BookRecord) {
  return (
    isSpreadOnlyConfigurationUpdate(changes, currentBook) &&
    Object.keys(changes).every((key) => readingActivityFields.has(key as keyof BookRecord))
  )
}

export function isReadingPositionOnlyUpdate(changes: Partial<BookRecord>, currentBook: BookRecord) {
  return (
    Object.keys(changes).some((key) => key === 'cfi' || key === 'percentage') &&
    hasOnlyReadingActivityFields(changes, currentBook)
  )
}

export function isReadingActivityOnlyUpdate(changes: Partial<BookRecord>, currentBook?: BookRecord) {
  return (
    Object.keys(changes).some((key) => key === 'cfi' || key === 'percentage' || key === 'lastReadAt') &&
    hasOnlyReadingActivityFields(changes, currentBook)
  )
}
