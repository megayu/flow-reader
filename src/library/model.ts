import { cleanBookText, compareBookDisplayTitle } from '../book'
import type { LibrarySortDirection, LibrarySortField } from '../state'
import {
  type BookExportFormat,
  type BookRecord,
  type BookSourceStatus,
  exportBook,
  type LibraryTagRecord,
  type ReadingStatus,
} from '../storage'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function toggleReadingStatusFilter(filters: ReadingStatus[], status: ReadingStatus) {
  return filters.includes(status) ? filters.filter((item) => item !== status) : [...filters, status]
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

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
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

export function bookExportFormats(book: BookRecord): BookExportFormat[] {
  return book.sourceFormat === 'txt' && book.managed ? ['epub', 'txt'] : ['epub']
}

export function isArchiveOnlyBook(book: BookRecord) {
  return book.archive === true
}

export const bookCoverCornerBadgeClassName =
  'flex size-8 items-center justify-center rounded-lg shadow-sm ring-1 ring-inset'
export const bookCoverCornerIconSize = 18
export const bookCoverCornerIconStrokeWidth = 2.2
export const bookSourceStatusRefreshEvent = 'flow-reader:book-source-status-refresh'
export const readingStatusOptions: ReadingStatus[] = ['toRead', 'reading', 'read']
export const readingStatusEditButtonClassName: Record<ReadingStatus | 'unmarked', string> = {
  unmarked: 'bg-popover/95 text-muted-foreground ring-border hover:bg-muted hover:text-foreground',
  toRead: 'bg-amber-50/95 text-amber-600 ring-amber-200 hover:bg-amber-100',
  reading: 'bg-sky-50/95 text-sky-600 ring-sky-200 hover:bg-sky-100',
  read: 'bg-emerald-50/95 text-emerald-600 ring-emerald-200 hover:bg-emerald-100',
}

export function isBookSourceUnavailable(status?: BookSourceStatus) {
  return status !== undefined && status !== 'available'
}

export function bookSourceDescriptionKey(status: Exclude<BookSourceStatus, 'available'>) {
  if (status === 'missing') return 'source_missing_description' as const
  if (status === 'changed') return 'source_changed_description' as const
  return 'source_unreadable_description' as const
}

export function bookSourceStatusFromError(errorMessage: string): Exclude<BookSourceStatus, 'available'> | undefined {
  if (errorMessage === 'BOOK_SOURCE_MISSING') return 'missing'
  if (errorMessage === 'BOOK_SOURCE_UNREADABLE') return 'unreadable'
  if (errorMessage === 'BOOK_SOURCE_CHANGED') return 'changed'
  return undefined
}

export function hasUnexportedBookChanges(book: BookRecord) {
  return !!book.contentEditedAt
}

export function exportDialogFilter(format: BookExportFormat) {
  return format === 'txt' ? { name: 'TXT', extensions: ['txt'] } : { name: 'EPUB', extensions: ['epub'] }
}

export function getExportDefaultPath(book: BookRecord, format: BookExportFormat) {
  const sourcePath = book.sourcePath
  if (book.sourceFormat === format) return sourcePath

  return sourcePath.replace(/\.[^./\\]+$/, `.${format}`)
}

export async function exportBookWithDialog(book: BookRecord, format: BookExportFormat) {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const outputPath = await save({
    defaultPath: getExportDefaultPath(book, format),
    filters: [exportDialogFilter(format)],
  })
  if (!outputPath) return

  await exportBook(book.id, format, outputPath)
  return outputPath
}

const preferredLanguageNames: Readonly<Record<string, string>> = {
  'zh-CN': '简体中文',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
}

export function formatLanguage(value?: string) {
  const language = cleanBookText(value)
  if (!language) return ''

  try {
    const canonicalLanguage = Intl.getCanonicalLocales(language.replaceAll('_', '-'))[0]
    if (!canonicalLanguage) return language

    return (
      preferredLanguageNames[canonicalLanguage] ??
      new Intl.DisplayNames([canonicalLanguage], { type: 'language' }).of(canonicalLanguage) ??
      language
    )
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

export function mergeLibraryTags(tags: LibraryTagRecord[], extraTags: LibraryTagRecord[]) {
  const byId = new Map<string, LibraryTagRecord>()
  ;[...tags, ...extraTags].forEach((tag) => {
    byId.set(tag.id, tag)
  })

  return Array.from(byId.values()).sort((a, b) => collator.compare(a.name, b.name))
}

export function sortBooks(books: BookRecord[], field: LibrarySortField, direction: LibrarySortDirection) {
  if (field === 'createdAt') {
    return [...books].sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt))
  }

  return [...books].sort((a, b) => {
    if (field === 'updatedAt') {
      if (a.lastReadAt === undefined || b.lastReadAt === undefined) {
        if (a.lastReadAt === b.lastReadAt) return 0
        return a.lastReadAt === undefined ? 1 : -1
      }

      const primary = a.lastReadAt - b.lastReadAt
      return direction === 'asc' ? primary : -primary
    }

    const primary =
      field === 'title'
        ? compareBookDisplayTitle(a, b)
        : collator.compare(cleanBookText(a.metadata.creator), cleanBookText(b.metadata.creator))
    return direction === 'asc' ? primary : -primary
  })
}

export function toggleSortDirection(direction: LibrarySortDirection): LibrarySortDirection {
  return direction === 'asc' ? 'desc' : 'asc'
}
