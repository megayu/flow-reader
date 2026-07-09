import type { PackagingMetadataObject } from '@flow/epubjs/types/packaging'

import type { Annotation } from './annotation'
import type { TypographyConfiguration } from './state'

export interface FileRecord {
  id: string
  file: File
}

export interface CoverRecord {
  id: string
  cover: string | null
}

export interface CoverInput {
  mimeType: string
  extension: string
  data: number[]
}

export interface TextImportEncodingOption {
  id: string
  label: string
}

export interface TextImportChapterPreview {
  title: string
  level: number
  role: 'group' | 'chapter'
}

export interface TextImportPreview {
  path: string
  filename: string
  title: string
  encoding: string
  encodingLabel: string
  confidence: 'high' | 'medium' | 'low' | 'failed'
  status: 'ready' | 'needsReview' | 'error' | 'skipped'
  selected: boolean
  message?: string | null
  sample: string
  chapters: TextImportChapterPreview[]
}

export interface TextImportSelection {
  path: string
  encoding?: string
  title?: string
  creator?: string
}

export interface TextImportRulesInput {
  groupPatterns: string[]
  chapterPatterns: string[]
}

export type BookSourceFormat = 'epub' | 'txt'
export type BookExportFormat = 'epub' | 'txt'
export type BookContentMode = 'normal' | 'archiveOnly'
export type BookContentFlag = 'nonPortableArchivePaths' | 'declaresEncryption'

export interface BookReaderSource {
  mode: 'opf' | 'epub'
  url: string
}

interface NativeBookReaderSource {
  mode: BookReaderSource['mode']
  path: string
}

export interface BookTextReplaceTarget {
  sectionHref: string
  textNodeIndex: number
  textNodeText: string
  startOffset: number
  endOffset: number
  paragraphIndex?: number
}

export interface BookTextReplaceResult {
  book: BookRecord
  sectionHref: string
  changed: boolean
}

export interface ReadingSpreadPageRecord {
  sectionIndex: number
  pageIndex: number
}

export interface ReadingSpreadRecord extends ReadingSpreadPageRecord {
  version: 1
  anchor: 'left' | 'right'
  exact?: boolean
  left?: ReadingSpreadPageRecord
  right?: ReadingSpreadPageRecord
  endsAtSectionEnd?: boolean
  layoutStyleSignature?: string
}

export type ReadingStatus = 'toRead' | 'reading' | 'read'

export interface LibraryTagRecord {
  id: string
  name: string
  createdAt: number
  updatedAt?: number
}

export interface BookRecord {
  id: string
  name: string
  size: number
  scope?: 'library' | 'external'
  readingStatus?: ReadingStatus | null
  sourceFormat?: BookSourceFormat
  exportedVersions?: Partial<Record<BookExportFormat, number>>
  contentEditedAt?: number
  metadata: PackagingMetadataObject
  createdAt: number
  updatedAt?: number
  lastReadAt?: number
  cfi?: string
  percentage?: number
  tagIds?: string[]
  definitions: string[]
  annotations: Annotation[]
  configuration?: {
    typography?: TypographyConfiguration
    spread?: ReadingSpreadRecord
  }
  contentHash?: string
  contentVersion?: number
  contentMode?: BookContentMode
  contentFlags?: BookContentFlag[]
  stateLoaded?: boolean
}

export interface EpubImportFailure {
  path: string
  filename: string
  error: string
}

export interface EpubImportResult {
  books: BookRecord[]
  failures: EpubImportFailure[]
}

export interface EpubImportProgress {
  importId: string
  total: number
  completed: number
  imported: number
  failed: number
  book?: BookRecord | null
  failure?: EpubImportFailure | null
}

export interface ReadingPositionInput {
  bookId: string
  cfi?: string
  percentage?: number
  spread?: ReadingSpreadRecord | null
  updatedAt: number
  sequence: number
}

export interface BookSearchHit {
  id: string
  excerpt: string
  cfi?: string | null
  sectionIndex: number
  href: string
  occurrence: number
  offset: number
}

export interface BookSearchResult {
  id: string
  excerpt: string
  description?: string | null
  subitems: BookSearchHit[]
  expanded: boolean
}

export type ImageFilterReason =
  | 'decorative'
  | 'duplicate'
  | 'icon'
  | 'inlineGlyph'
  | 'titleArt'

export interface BookImageIndexEntry {
  src: string
  index: number
  hiddenByDefault: boolean
  reason?: ImageFilterReason | null
}

export interface BookImageIndexSection {
  sectionIndex: number
  href: string
  title?: string | null
  navPath?: string[]
  images: BookImageIndexEntry[]
}

export interface BookImageIndexCache {
  version: number
  extractorVersion: number
  bookHash: string
  contentVersion: number
  sections: BookImageIndexSection[]
}

export interface BookImageIndexCacheInput {
  bookHash: string
  contentVersion: number
  sections: BookImageIndexSection[]
}

type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>

type Listener = () => void
type TableName = 'books' | 'covers' | 'files' | 'settings' | 'tags'

const listeners = new Map<TableName, Set<Listener>>()
const bookCache = new Map<string, BookRecord>()
let booksCache: BookRecord[] | undefined
let coversCache: CoverRecord[] | undefined
let tagsCache: LibraryTagRecord[] | undefined
const pendingNativeWrites = new Set<Promise<unknown>>()

function subscribe(table: TableName, listener: Listener) {
  let set = listeners.get(table)
  if (!set) {
    set = new Set()
    listeners.set(table, set)
  }
  set.add(listener)

  return () => {
    set?.delete(listener)
  }
}

function notify(...tables: TableName[]) {
  tables.forEach((table) => {
    listeners.get(table)?.forEach((listener) => listener())
  })
}

function asFullBook(book: BookRecord) {
  return { ...book, stateLoaded: true }
}

function asBookSummary(book: BookRecord) {
  return { ...book, stateLoaded: false }
}

function mergeBookSummary(book: BookRecord, existing?: BookRecord) {
  if (!existing?.stateLoaded) return asBookSummary(book)

  return {
    ...existing,
    ...book,
    definitions: existing.definitions,
    annotations: existing.annotations,
    configuration: existing.configuration,
    stateLoaded: true,
  }
}

function rememberBook(book: BookRecord, { full = true } = {}) {
  const normalized = full
    ? asFullBook(book)
    : mergeBookSummary(book, bookCache.get(book.id))
  bookCache.set(book.id, normalized)

  if (!booksCache) return

  const index = booksCache.findIndex((item) => item.id === book.id)
  if (index >= 0) {
    if (normalized.scope === 'external') {
      booksCache = [
        ...booksCache.slice(0, index),
        ...booksCache.slice(index + 1),
      ]
      return
    }

    booksCache = [
      ...booksCache.slice(0, index),
      normalized,
      ...booksCache.slice(index + 1),
    ]
  } else if (normalized.scope !== 'external') {
    booksCache = [...booksCache, normalized]
  }
}

function rememberBooks(books: BookRecord[]) {
  booksCache = books.map((book) =>
    mergeBookSummary(book, bookCache.get(book.id)),
  )
  bookCache.clear()
  booksCache.forEach((book) => bookCache.set(book.id, book))
}

function forgetBooks(ids: string[]) {
  ids.forEach((id) => bookCache.delete(id))
  if (booksCache) {
    booksCache = booksCache.filter((book) => !ids.includes(book.id))
  }
}

function rememberCovers(covers: CoverRecord[]) {
  coversCache = covers
}

function forgetCovers(ids: string[]) {
  if (coversCache) {
    coversCache = coversCache.filter((cover) => !ids.includes(cover.id))
  }
}

function invalidateCovers() {
  coversCache = undefined
}

function rememberTags(tags: LibraryTagRecord[]) {
  tagsCache = tags
}

function rememberTag(tag: LibraryTagRecord) {
  if (!tagsCache) return

  const index = tagsCache.findIndex((item) => item.id === tag.id)
  if (index >= 0) {
    tagsCache = [
      ...tagsCache.slice(0, index),
      tag,
      ...tagsCache.slice(index + 1),
    ]
  } else {
    tagsCache = [...tagsCache, tag]
  }
}

function forgetTag(id: string) {
  if (tagsCache) {
    tagsCache = tagsCache.filter((tag) => tag.id !== id)
  }
}

function withoutReadingSpread(
  configuration: BookRecord['configuration'] | undefined,
) {
  const { spread, ...rest } = configuration ?? {}
  return rest
}

function isSpreadOnlyConfigurationUpdate(
  changes: Partial<BookRecord>,
  currentBook?: BookRecord,
) {
  if (!('configuration' in changes)) return true
  if (!currentBook) return false

  return (
    JSON.stringify(withoutReadingSpread(changes.configuration)) ===
    JSON.stringify(withoutReadingSpread(currentBook.configuration))
  )
}

function isReadingPositionOnlyUpdate(
  changes: Partial<BookRecord>,
  currentBook?: BookRecord,
) {
  const keys = Object.keys(changes)
  return (
    keys.length > 0 &&
    keys.some((key) => key === 'cfi' || key === 'percentage') &&
    isSpreadOnlyConfigurationUpdate(changes, currentBook) &&
    keys.every((key) =>
      [
        'cfi',
        'percentage',
        'updatedAt',
        'lastReadAt',
        'configuration',
      ].includes(key),
    )
  )
}

let invokePromise: Promise<NativeInvoke> | undefined
let convertFileSrcPromise:
  | Promise<((filePath: string, protocol?: string) => string) | undefined>
  | undefined

async function getInvoke() {
  if (typeof window === 'undefined') {
    throw new Error('Native storage is not available on the server')
  }

  invokePromise ??= import('@tauri-apps/api/core').then(({ invoke }) => invoke)
  return invokePromise
}

async function invoke<T>(command: string, args?: Record<string, unknown>) {
  return (await getInvoke())<T>(command, args)
}

function trackNativeWrite<T>(promise: Promise<T>) {
  const tracked = promise.finally(() => {
    pendingNativeWrites.delete(tracked)
  })

  pendingNativeWrites.add(tracked)
  return tracked
}

async function waitForPendingNativeWrites() {
  while (pendingNativeWrites.size) {
    await Promise.allSettled(Array.from(pendingNativeWrites))
  }
}

async function filePathToUrl(path: string) {
  try {
    convertFileSrcPromise ??= import('@tauri-apps/api/core').then(
      ({ convertFileSrc }) => convertFileSrc,
    )
    const convertFileSrc = await convertFileSrcPromise
    const normalizedPath = path.replace(/\\/g, '/')
    return convertFileSrc?.(normalizedPath) ?? normalizedPath
  } catch {
    return path
  }
}

function addCacheBuster(url: string, version: string | number = Date.now()) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(
    String(version),
  )}`
}

async function toCoverRecord(record: CoverRecord | null) {
  if (!record) return undefined

  const cover = record.cover ? await filePathToUrl(record.cover) : null
  return {
    ...record,
    cover: cover ? addCacheBuster(cover) : null,
  }
}

export const db = {
  subscribe,
  notify,
  async flush() {
    await waitForPendingNativeWrites()
    return invoke('flush_storage')
  },
  books: {
    async toArray() {
      if (booksCache) return booksCache

      const books = await invoke<BookRecord[]>('list_books')
      rememberBooks(books)
      return books
    },
    get(id: string) {
      const cached = bookCache.get(id)
      if (cached?.stateLoaded) return Promise.resolve(cached)

      return invoke<BookRecord | null>('get_book', { id }).then((book) => {
        if (book) {
          const loadedBook = asFullBook(book)
          rememberBook(loadedBook)
          return loadedBook
        }
        return undefined
      })
    },
    peek(id: string) {
      return bookCache.get(id)
    },
    peekAll() {
      return booksCache
    },
    openDirectory(id: string) {
      return invoke('open_book_directory', { id })
    },
    remember(book: BookRecord) {
      rememberBook(book)
    },
    recordReadingPosition(position: ReadingPositionInput) {
      return trackNativeWrite(
        invoke<boolean>('record_reading_position', { position }),
      )
    },
    async update(id: string, changes: Partial<BookRecord>) {
      const cached = bookCache.get(id)
      const readingPositionOnly = isReadingPositionOnlyUpdate(changes, cached)
      if (cached) {
        rememberBook({ ...cached, ...changes }, { full: cached.stateLoaded })
      }

      const book = await trackNativeWrite(
        invoke<BookRecord | null>('update_book', {
          id,
          changes,
        }),
      )
      if (book) rememberBook(book)

      if (!readingPositionOnly) {
        if (changes.metadata) invalidateCovers()
        notify(
          ...(['books', changes.metadata ? 'covers' : undefined].filter(
            Boolean,
          ) as TableName[]),
        )
      }
      return book ?? undefined
    },
    async bulkDelete(ids: string[]) {
      await trackNativeWrite(invoke('delete_books', { ids }))
      forgetBooks(ids)
      forgetCovers(ids)
      notify('books', 'covers', 'files')
    },
    async delete(id: string) {
      await this.bulkDelete([id])
    },
    async updateTags(
      ids: string[],
      {
        addTagIds = [],
        removeTagIds = [],
      }: { addTagIds?: string[]; removeTagIds?: string[] },
    ) {
      const books = await trackNativeWrite(
        invoke<BookRecord[]>('update_book_tags', {
          ids,
          addTagIds,
          removeTagIds,
        }),
      )
      books.forEach((book) => rememberBook(book, { full: false }))
      notify('books')
      return books
    },
  },
  tags: {
    async toArray() {
      if (tagsCache) return tagsCache

      const tags = await invoke<LibraryTagRecord[]>('list_tags')
      rememberTags(tags)
      return tags
    },
    peekAll() {
      return tagsCache
    },
    async create(name: string) {
      const tag = await trackNativeWrite(
        invoke<LibraryTagRecord | null>('create_tag', { name }),
      )
      if (tag) rememberTag(tag)
      notify('tags')
      return tag ?? undefined
    },
    async update(id: string, name: string) {
      const tag = await trackNativeWrite(
        invoke<LibraryTagRecord | null>('update_tag', { id, name }),
      )
      if (tag) rememberTag(tag)
      notify('tags')
      return tag ?? undefined
    },
    async delete(id: string) {
      const books = await trackNativeWrite(
        invoke<BookRecord[]>('delete_tag', { id }),
      )
      forgetTag(id)
      books.forEach((book) => rememberBook(book, { full: false }))
      notify('tags', 'books')
      return books
    },
  },
  files: {
    async getPackageUrl(id: string) {
      const path = await invoke<string>('get_book_package_path', { id })
      return filePathToUrl(path)
    },
    async getReaderSource(id: string): Promise<BookReaderSource> {
      const source = await invoke<NativeBookReaderSource>(
        'get_book_reader_source',
        { id },
      )
      return {
        mode: source.mode,
        url: await filePathToUrl(source.path),
      }
    },
    async bulkDelete(ids: string[]) {
      await db.books.bulkDelete(ids)
    },
    async delete(id: string) {
      await db.books.delete(id)
    },
  },
  covers: {
    async toArray() {
      if (coversCache) return coversCache

      const covers = await invoke<CoverRecord[]>('list_covers')
      const normalized = await Promise.all(
        covers.map(async (cover) => ({
          ...cover,
          cover: cover.cover
            ? addCacheBuster(await filePathToUrl(cover.cover))
            : null,
        })),
      )
      rememberCovers(normalized)
      return normalized
    },
    peekAll() {
      return coversCache
    },
    get(id: string) {
      return invoke<CoverRecord | null>('get_cover', { id }).then((cover) =>
        toCoverRecord(cover),
      )
    },
    async put(record: { id: string; cover: CoverInput | null }) {
      await trackNativeWrite(
        invoke('update_cover', {
          id: record.id,
          cover: record.cover,
        }),
      )
      invalidateCovers()
      notify('covers')
      return record.id
    },
    async bulkDelete(ids: string[]) {
      await db.books.bulkDelete(ids)
    },
    async delete(id: string) {
      await db.books.delete(id)
    },
  },
}

export async function importBookPaths(
  paths: string[],
  {
    importId,
    replaceExisting = true,
  }: { importId?: string; replaceExisting?: boolean } = {},
) {
  const result = await trackNativeWrite(
    invoke<EpubImportResult>('import_epub_paths', {
      importId,
      paths,
      replaceExisting,
    }),
  )
  result.books.forEach((book) => rememberBook(book))
  if (result.books.length) {
    invalidateCovers()
    notify('books', 'covers', 'files')
  }
  return result
}

export async function openExternalBookPaths(paths: string[]) {
  const result = await trackNativeWrite(
    invoke<EpubImportResult>('open_external_epub_paths', { paths }),
  )
  result.books.forEach((book) => rememberBook(book))
  return result
}

export function getTextImportEncodings() {
  return invoke<TextImportEncodingOption[]>('get_text_import_encodings')
}

export function previewTextImportPaths(
  paths: string[],
  encodings: Record<string, string> = {},
  rules?: TextImportRulesInput,
) {
  return invoke<TextImportPreview[]>('preview_text_import_paths', {
    paths,
    encodings,
    rules,
  })
}

export async function importTextPaths(
  imports: TextImportSelection[],
  {
    replaceExisting = true,
    rules,
  }: { replaceExisting?: boolean; rules?: TextImportRulesInput } = {},
) {
  const books = await trackNativeWrite(
    invoke<BookRecord[]>('import_text_paths', {
      imports,
      replaceExisting,
      rules,
    }),
  )
  books.forEach((book) => rememberBook(book))
  invalidateCovers()
  notify('books', 'covers', 'files')
  return books
}

export function searchBookText(id: string, keyword: string, limit?: number) {
  return invoke<BookSearchResult[]>('search_book_text', {
    id,
    keyword,
    limit,
  })
}

export function loadBookImageIndex(id: string) {
  return invoke<BookImageIndexCache | null>('load_book_image_index', { id })
}

export function storeBookImageIndex(
  id: string,
  cache: BookImageIndexCacheInput,
) {
  return invoke<boolean>('store_book_image_index', { id, cache })
}

export async function replaceBookText({
  id,
  target,
  oldText,
  newText,
}: {
  id: string
  target: BookTextReplaceTarget
  oldText: string
  newText: string
}) {
  const result = await trackNativeWrite(
    invoke<BookTextReplaceResult>('replace_book_text', {
      id,
      target,
      oldText,
      newText,
    }),
  )
  rememberBook(result.book)
  notify('books', 'files')
  return result
}

export async function exportBook(
  id: string,
  format: BookExportFormat,
  outputPath: string,
) {
  const book = await trackNativeWrite(
    invoke<BookRecord | null>('export_book', { id, format, outputPath }),
  )
  if (book) {
    rememberBook(book)
    notify('books')
  }
  return book ?? undefined
}

export function unloadBookSearchText(id: string) {
  return invoke('unload_book_search_text', { id })
}

export function cleanupExternalBook(id: string) {
  return trackNativeWrite(invoke('cleanup_external_book', { id }))
}

export function cleanupAllExternalBooks() {
  return trackNativeWrite(invoke('cleanup_all_external_books'))
}

export function deleteExternalBook(id: string) {
  forgetBooks([id])
  forgetCovers([id])
  return trackNativeWrite(invoke('delete_external_book', { id }))
}

export async function getSettingsFromStorage<T>() {
  return invoke<T>('get_settings')
}

export async function updateSettingsInStorage<T>(settings: T) {
  await trackNativeWrite(invoke('update_settings', { settings }))
  notify('settings')
}
