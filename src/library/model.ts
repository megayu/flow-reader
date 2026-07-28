import {
  cleanBookText,
  compareBookDisplayTitle,
  getBookDisplayTitle,
  stripFileExtension,
} from '../book'
import type { LibrarySortDirection, LibrarySortField } from '../state'
import {
  exportBook,
  type BookExportFormat,
  type BookRecord,
  type BookSourceStatus,
  type LibraryTagRecord,
  type ReadingStatus,
} from '../storage'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function toggleReadingStatusFilter(
  filters: ReadingStatus[],
  status: ReadingStatus,
) {
  return filters.includes(status)
    ? filters.filter((item) => item !== status)
    : [...filters, status]
}

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 2)} ${
    units[unitIndex]
  }`
}

export function formatDateTime(value?: number) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

export function formatPercentage(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''

  return `${Math.max(0, Math.min(100, value * 100)).toFixed(2)}%`
}

export function getBookProgressPercent(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return

  return Math.max(0, Math.min(100, value * 100))
}

export function bookSourceFormat(book: BookRecord) {
  return (
    book.sourceFormat ??
    (((book.metadata as { sourceFormat?: string }).sourceFormat === 'txt'
      ? 'txt'
      : 'epub') as BookRecord['sourceFormat'])
  )
}

export function bookExportFormats(book: BookRecord): BookExportFormat[] {
  return bookSourceFormat(book) === 'txt' && book.sourceStorage !== 'referenced'
    ? ['txt', 'epub']
    : ['epub']
}

export function isArchiveOnlyBook(book: BookRecord) {
  return (
    book.contentMode === 'archiveOnly' ||
    book.contentFlags?.includes('nonPortableArchivePaths') === true
  )
}

export const bookCoverCornerBadgeClassName =
  'flex size-8 items-center justify-center rounded-lg shadow-sm ring-1 ring-inset'
export const bookCoverCornerIconSize = 18
export const bookCoverCornerIconStrokeWidth = 2.2
export const bookSourceStatusRefreshEvent =
  'flow-reader:book-source-status-refresh'

export function isBookSourceUnavailable(status?: BookSourceStatus) {
  return status !== undefined && status !== 'available'
}

export function bookSourceDescriptionKey(
  status: Exclude<BookSourceStatus, 'available'>,
) {
  if (status === 'missing') return 'source_missing_description' as const
  if (status === 'changed') return 'source_changed_description' as const
  return 'source_unreadable_description' as const
}

export function bookSourceStatusFromError(
  errorMessage: string,
): Exclude<BookSourceStatus, 'available'> | undefined {
  if (errorMessage === 'BOOK_SOURCE_MISSING') return 'missing'
  if (errorMessage === 'BOOK_SOURCE_UNREADABLE') return 'unreadable'
  if (errorMessage === 'BOOK_SOURCE_CHANGED') return 'changed'
  return undefined
}

export function isBookExportDirty(book: BookRecord, format: BookExportFormat) {
  return (
    !!book.contentEditedAt &&
    (book.exportedVersions?.[format] ?? 0) < (book.contentVersion ?? 0)
  )
}

export function hasUnexportedBookChanges(book: BookRecord) {
  return bookExportFormats(book).every((format) =>
    isBookExportDirty(book, format),
  )
}

export function exportFormatExtension(format: BookExportFormat) {
  return format === 'txt' ? 'txt' : 'epub'
}

export function exportDialogFilter(format: BookExportFormat) {
  return format === 'txt'
    ? { name: 'TXT', extensions: ['txt'] }
    : { name: 'EPUB', extensions: ['epub'] }
}

export function cleanExportFileName(value: string) {
  const fallback = 'book'
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return cleaned || fallback
}

export function getExportDefaultPath(
  book: BookRecord,
  format: BookExportFormat,
) {
  const base = cleanExportFileName(
    stripFileExtension(book.name) || getBookDisplayTitle(book),
  )
  return `${base}.${exportFormatExtension(format)}`
}

export async function exportBookWithDialog(
  book: BookRecord,
  format: BookExportFormat,
) {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const outputPath = await save({
    defaultPath: getExportDefaultPath(book, format),
    filters: [exportDialogFilter(format)],
  })
  if (!outputPath) return

  await exportBook(book.id, format, outputPath)
}

let languageDisplayNamesLocale: string | undefined
let languageDisplayNames: Intl.DisplayNames | undefined

export function formatLanguage(value?: string) {
  const language = cleanBookText(value)
  if (!language) return ''

  try {
    const locale = navigator.language
    if (!languageDisplayNames || languageDisplayNamesLocale !== locale) {
      languageDisplayNamesLocale = locale
      languageDisplayNames = new Intl.DisplayNames([locale], {
        type: 'language',
      })
    }
    return languageDisplayNames.of(language) ?? language
  } catch {
    return language
  }
}

export function cleanBookDescription(value?: string) {
  if (!value) return ''

  const paragraphs: string[] = []
  for (const paragraph of value.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const normalized = paragraph.replace(/[ \t\n]+/g, ' ').trim()
    if (normalized) paragraphs.push(normalized)
  }
  return paragraphs.join('\n\n')
}

export function uniqueStringValues(values: string[]) {
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

export function mergeLibraryTags(
  tags: LibraryTagRecord[],
  extraTags: LibraryTagRecord[],
) {
  const byId = new Map<string, LibraryTagRecord>()
  ;[...tags, ...extraTags].forEach((tag) => {
    byId.set(tag.id, tag)
  })

  return Array.from(byId.values()).sort((a, b) =>
    collator.compare(a.name, b.name),
  )
}

export function clampMenuPosition(x: number, y: number) {
  if (typeof window === 'undefined') return { x, y }

  return {
    x: Math.min(x, Math.max(8, window.innerWidth - 176)),
    y: Math.min(y, Math.max(8, window.innerHeight - 208)),
  }
}

function compareBookTitle(a: BookRecord, b: BookRecord) {
  return compareBookDisplayTitle(a, b)
}

function compareBookString(
  a: BookRecord,
  b: BookRecord,
  getValue: (book: BookRecord) => string,
) {
  return collator.compare(getValue(a), getValue(b))
}

function compareBookNumber(
  a: BookRecord,
  b: BookRecord,
  getValue: (book: BookRecord) => number | undefined,
) {
  return (getValue(a) ?? 0) - (getValue(b) ?? 0)
}

function compareBooksByField(
  a: BookRecord,
  b: BookRecord,
  field: LibrarySortField,
) {
  if (field === 'title') return compareBookTitle(a, b)
  if (field === 'creator') {
    return compareBookString(a, b, (book) =>
      cleanBookText(book.metadata.creator),
    )
  }
  if (field === 'updatedAt') {
    return compareBookNumber(a, b, (book) => book.lastReadAt ?? book.updatedAt)
  }

  return compareBookNumber(a, b, (book) => book.createdAt)
}

export function sortBooks(
  books: BookRecord[],
  field: LibrarySortField,
  direction: LibrarySortDirection,
) {
  return [...books].sort((a, b) => {
    const primary = compareBooksByField(a, b, field)
    if (primary) return direction === 'asc' ? primary : -primary

    if (field !== 'title') {
      return compareBookTitle(a, b)
    }

    return 0
  })
}

export function toggleSortDirection(
  direction: LibrarySortDirection,
): LibrarySortDirection {
  return direction === 'asc' ? 'desc' : 'asc'
}
