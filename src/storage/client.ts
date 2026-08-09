import { Channel } from '@tauri-apps/api/core'

import { RecentReadingModel } from '../library/recentReading'

import { storagePathToUrl as filePathToUrl, invokeStorage as invoke } from './native'
import type {
  BookCacheClearProgress,
  BookExportFormat,
  BookImageIndexCache,
  BookImportProgress,
  BookImportResult,
  BookReaderSource,
  BookRecord,
  BookSearchResult,
  BookSourceStatusRecord,
  BookTextReplaceResult,
  BookTextReplaceTarget,
  CoverRecord,
  FolderImportCandidate,
  FolderImportTagAssignment,
  FolderImportTagResult,
  LibraryPins,
  LibraryTagRecord,
  ReadingPositionInput,
  ReadingStatus,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportSelection,
} from './types'

interface NativeBookReaderSource {
  mode: BookReaderSource['mode']
  path: string
  rootPath?: string
  book?: BookRecord
}

type Listener = () => void
type TableName = 'books' | 'covers' | 'pins' | 'recentBooks' | 'settings' | 'tags'

const listeners = new Map<TableName, Set<Listener>>()
const bookCache = new Map<string, BookRecord>()
let booksCache: BookRecord[] | undefined
let booksCacheEpoch = 0
let booksListPromise: Promise<BookRecord[]> | undefined
let coversCache: CoverRecord[] | undefined
let tagsCache: LibraryTagRecord[] | undefined
let pinsCache: LibraryPins | undefined
const recentReading = new RecentReadingModel()
let recentBooksLoaded = false
let recentBooksPromise: Promise<string[]> | undefined
let recentBooksChangedDuringLoad = false
const pendingNativeWrites = new Set<Promise<unknown>>()

function beginBooksMutation() {
  booksCacheEpoch++
}

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
  return {
    ...book,
    definitions: [],
    annotations: [],
    configuration: undefined,
    stateLoaded: false,
  }
}

function rememberBook(book: BookRecord) {
  const normalized = asBookSummary(book)
  bookCache.set(book.id, normalized)

  if (!booksCache) return

  const index = booksCache.findIndex((item) => item.id === book.id)
  if (index >= 0) {
    if (normalized.scope === 'external') {
      booksCache = [...booksCache.slice(0, index), ...booksCache.slice(index + 1)]
      return
    }

    booksCache = [...booksCache.slice(0, index), normalized, ...booksCache.slice(index + 1)]
  } else if (normalized.scope !== 'external') {
    booksCache = [...booksCache, normalized]
  }
}

function rememberBookBatch(books: BookRecord[]) {
  if (!books.length) return

  const normalized = books.map(asBookSummary)
  const updates = new Map(normalized.map((book) => [book.id, book]))
  updates.forEach((book, id) => bookCache.set(id, book))
  if (!booksCache) return

  const seen = new Set<string>()
  const next = booksCache.flatMap((book) => {
    const update = updates.get(book.id)
    if (!update) return [book]
    seen.add(book.id)
    return update.scope === 'external' ? [] : [update]
  })
  updates.forEach((book) => {
    if (!seen.has(book.id) && book.scope !== 'external') {
      seen.add(book.id)
      next.push(book)
    }
  })
  booksCache = next
}

function rememberBooks(books: BookRecord[]) {
  booksCache = books.map(asBookSummary)
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

function rememberCover(cover: CoverRecord) {
  if (!coversCache) return

  const index = coversCache.findIndex((item) => item.id === cover.id)
  coversCache =
    index >= 0 ? [...coversCache.slice(0, index), cover, ...coversCache.slice(index + 1)] : [...coversCache, cover]
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
    tagsCache = [...tagsCache.slice(0, index), tag, ...tagsCache.slice(index + 1)]
  } else {
    tagsCache = [...tagsCache, tag]
  }
}

function applyDeletedTags(ids: string[]) {
  const removed = new Set(ids)
  if (!removed.size) return

  const update = (book: BookRecord) => {
    const tagIds = book.tagIds ?? []
    return tagIds.some((tagId) => removed.has(tagId))
      ? { ...book, tagIds: tagIds.filter((tagId) => !removed.has(tagId)) }
      : book
  }
  bookCache.forEach((book, bookId) => bookCache.set(bookId, update(book)))
  if (booksCache) booksCache = booksCache.map(update)
  if (tagsCache) tagsCache = tagsCache.filter((tag) => !removed.has(tag.id))
}

function rememberPins(pins: LibraryPins) {
  pinsCache = pins
}

async function updateLibraryPin(kind: 'author' | 'tag', id: string, pinned: boolean) {
  const pins = await trackNativeWrite(invoke<LibraryPins>('update_library_pin', { kind, id, pinned }))
  rememberPins(pins)
  notify('pins')
  return pins
}

function invalidatePins() {
  pinsCache = undefined
}

function loadRecentBooks() {
  if (recentBooksLoaded) return Promise.resolve(recentReading.snapshot())
  if (recentBooksPromise) return recentBooksPromise

  const request = invoke<string[] | undefined>('get_recent_book_ids').then((ids) => {
    const storedIds = ids ?? []
    recentReading.replace(recentBooksChangedDuringLoad ? [...recentReading.snapshot(), ...storedIds] : storedIds)
    recentBooksChangedDuringLoad = false
    recentBooksLoaded = true
    return recentReading.snapshot()
  })
  const tracked = request.finally(() => {
    if (recentBooksPromise === tracked) recentBooksPromise = undefined
  })
  recentBooksPromise = tracked
  return tracked
}

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

function isReadingPositionOnlyUpdate(changes: Partial<BookRecord>, currentBook?: BookRecord) {
  const keys = Object.keys(changes)
  return (
    keys.length > 0 &&
    keys.some((key) => key === 'cfi' || key === 'percentage') &&
    isSpreadOnlyConfigurationUpdate(changes, currentBook) &&
    keys.every((key) => ['cfi', 'percentage', 'updatedAt', 'lastReadAt', 'configuration'].includes(key))
  )
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

async function fetchCurrentBooks(): Promise<BookRecord[]> {
  await waitForPendingNativeWrites()
  if (booksCache) return booksCache

  const requestEpoch = booksCacheEpoch
  const books = await invoke<BookRecord[]>('list_books')
  if (requestEpoch !== booksCacheEpoch) return fetchCurrentBooks()

  rememberBooks(books)
  return booksCache ?? []
}

function loadBooks() {
  if (booksCache) return Promise.resolve(booksCache)
  if (booksListPromise) return booksListPromise

  const request = fetchCurrentBooks()
  const tracked = request.finally(() => {
    if (booksListPromise === tracked) booksListPromise = undefined
  })
  booksListPromise = tracked
  return tracked
}

function addCacheBuster(url: string, version: string | number = Date.now()) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`
}

function normalizeCoverRecord(record: CoverRecord) {
  const cover = record.cover ? filePathToUrl(record.cover) : null
  return {
    ...record,
    cover: cover ? addCacheBuster(cover) : null,
  }
}

function rememberBookImportProgress(progress: BookImportProgress) {
  if (!progress.book) return

  rememberBook(progress.book)
  if (progress.cover) rememberCover(normalizeCoverRecord(progress.cover))
  notify('books', ...(progress.cover ? (['covers'] as const) : []))
}

type NativeBookImportProgress = Omit<BookImportProgress, 'importId'>

async function importBooksWithProgress(
  command: 'import_epub_paths' | 'import_text_paths',
  args: Record<string, unknown>,
  importId: string | undefined,
  onProgress: ((progress: BookImportProgress) => void) | undefined,
) {
  await waitForPendingNativeWrites()
  beginBooksMutation()

  const books = new Map<string, BookRecord>()
  const progressChannel = new Channel<NativeBookImportProgress>((nativeProgress) => {
    const progress = { ...nativeProgress, importId: importId ?? '' }
    if (progress.book) books.set(progress.book.id, progress.book)
    rememberBookImportProgress(progress)
    onProgress?.(progress)
  })
  const result = await trackNativeWrite(
    invoke<BookImportResult>(command, {
      ...args,
      onProgress: progressChannel,
    }),
  )
  result.books.forEach((book) => {
    books.set(book.id, book)
    rememberBook(book)
  })
  if (result.books.length && coversCache) {
    const fallbackCovers = await invoke<CoverRecord[]>('list_covers', {
      ids: result.books.map((book) => book.id),
    })
    fallbackCovers.forEach((cover) => rememberCover(normalizeCoverRecord(cover)))
  }

  const importedBooks = [...books.values()]
  if (importedBooks.length) {
    invalidatePins()
    notify('books', 'covers', 'pins')
  }
  return { books: importedBooks, failures: result.failures }
}

export const db = {
  subscribe,
  notify,
  waitForPendingWrites: waitForPendingNativeWrites,
  books: {
    async toArray() {
      return loadBooks()
    },
    async get(id: string): Promise<BookRecord | undefined> {
      const requestEpoch = booksCacheEpoch
      const book = await invoke<BookRecord | null>('get_book', { id })
      if (requestEpoch !== booksCacheEpoch) return db.books.get(id)
      if (!book) return undefined

      const loadedBook = asFullBook(book)
      rememberBook(book)
      return loadedBook
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
    revealSource(id: string) {
      return invoke<boolean>('reveal_book_source', { id })
    },
    remember(book: BookRecord) {
      beginBooksMutation()
      rememberBook(book)
    },
    rememberUpdate(book: BookRecord, changes: Partial<BookRecord>) {
      beginBooksMutation()
      const cached = bookCache.get(book.id)
      const base = cached ?? book
      rememberBook({ ...base, ...changes })
    },
    recordReadingPosition(position: ReadingPositionInput) {
      return trackNativeWrite(invoke<void>('record_reading_position', { position }))
    },
    async update(id: string, changes: Partial<BookRecord>) {
      beginBooksMutation()
      const cached = bookCache.get(id)
      const normalizedChanges = changes.tagIds
        ? { ...changes, tagIds: [...new Set(changes.tagIds.filter(Boolean))] }
        : changes
      const readingPositionOnly = isReadingPositionOnlyUpdate(normalizedChanges, cached)
      if (cached) {
        rememberBook({ ...cached, ...normalizedChanges })
      }

      await trackNativeWrite(
        invoke<void>('update_book', {
          id,
          changes: normalizedChanges,
        }),
      )

      if (!readingPositionOnly) {
        if (normalizedChanges.metadata) invalidateCovers()
        if (normalizedChanges.metadata) invalidatePins()
        notify(
          ...([
            'books',
            normalizedChanges.metadata ? 'covers' : undefined,
            normalizedChanges.metadata ? 'pins' : undefined,
          ].filter(Boolean) as TableName[]),
        )
      }
    },
    checkSourceStatuses(ids: string[]) {
      return invoke<BookSourceStatusRecord[]>('check_book_source_statuses', {
        ids,
      })
    },
    async bulkDelete(ids: string[]) {
      beginBooksMutation()
      await trackNativeWrite(invoke('delete_books', { ids }))
      forgetBooks(ids)
      forgetCovers(ids)
      invalidatePins()
      notify('books', 'covers', 'pins')
    },
    async delete(id: string) {
      await this.bulkDelete([id])
    },
    async updateReadingStatus(ids: string[], readingStatus: ReadingStatus | null) {
      beginBooksMutation()
      const books = ids.flatMap((id) => {
        const book = bookCache.get(id)
        return book ? [{ ...book, readingStatus }] : []
      })
      await trackNativeWrite(
        invoke<void>('update_book_reading_status', {
          ids,
          readingStatus,
        }),
      )
      rememberBookBatch(books)
      notify('books')
    },
    async updateTags(
      ids: string[],
      { addTagIds = [], removeTagIds = [] }: { addTagIds?: string[]; removeTagIds?: string[] },
    ) {
      beginBooksMutation()
      const existingTagIds = tagsCache ? new Set(tagsCache.map((tag) => tag.id)) : undefined
      const additions = [
        ...new Set(addTagIds.filter((tagId) => tagId && (!existingTagIds || existingTagIds.has(tagId)))),
      ]
      const removals = new Set(removeTagIds.filter(Boolean))
      const books = ids.flatMap((id) => {
        const book = bookCache.get(id)
        if (!book) return []

        const tagIds = new Set(book.tagIds)
        removals.forEach((tagId) => tagIds.delete(tagId))
        additions.forEach((tagId) => tagIds.add(tagId))
        return [{ ...book, tagIds: [...tagIds] }]
      })
      await trackNativeWrite(
        invoke<void>('update_book_tags', {
          ids,
          addTagIds: additions,
          removeTagIds: [...removals],
        }),
      )
      rememberBookBatch(books)
      notify('books')
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
      const tag = await trackNativeWrite(invoke<LibraryTagRecord | null>('create_tag', { name }))
      if (tag) rememberTag(tag)
      notify('tags')
      return tag ?? undefined
    },
    async update(id: string, name: string) {
      const tag = await trackNativeWrite(invoke<LibraryTagRecord | null>('update_tag', { id, name }))
      if (tag) rememberTag(tag)
      notify('tags')
      return tag ?? undefined
    },
    async delete(id: string) {
      await this.deleteMany([id])
    },
    async deleteMany(ids: string[]) {
      const uniqueIds = [...new Set(ids.filter(Boolean))]
      if (!uniqueIds.length) return
      beginBooksMutation()
      await trackNativeWrite(invoke<void>('delete_tags', { ids: uniqueIds }))
      applyDeletedTags(uniqueIds)
      invalidatePins()
      notify('tags', 'books', 'pins')
    },
    async merge(ids: string[], target: { id?: string; name?: string }) {
      beginBooksMutation()
      const sourceIds = [...new Set(ids.filter(Boolean))]
      const sourceIdSet = new Set(sourceIds)
      const tag = await trackNativeWrite(
        invoke<LibraryTagRecord>('merge_tags', {
          ids: sourceIds,
          targetId: target.id,
          targetName: target.name,
        }),
      )
      const update = (book: BookRecord) => {
        const tagIds = book.tagIds ?? []
        if (!tagIds.some((tagId) => sourceIdSet.has(tagId))) return book

        return { ...book, tagIds: [...tagIds.filter((tagId) => !sourceIdSet.has(tagId)), tag.id] }
      }
      bookCache.forEach((book, bookId) => bookCache.set(bookId, update(book)))
      if (booksCache) booksCache = booksCache.map(update)
      if (tagsCache) tagsCache = tagsCache.filter((item) => !sourceIdSet.has(item.id) || item.id === tag.id)
      rememberTag(tag)
      invalidatePins()
      notify('tags', 'books', 'pins')
      return tag
    },
  },
  pins: {
    async get() {
      if (pinsCache) return pinsCache

      const pins = await invoke<LibraryPins>('get_library_pins')
      rememberPins(pins)
      return pins
    },
    peek() {
      return pinsCache
    },
    async pinAuthor(author: string) {
      return updateLibraryPin('author', author, true)
    },
    async unpinAuthor(author: string) {
      return updateLibraryPin('author', author, false)
    },
    async pinTag(tagId: string) {
      return updateLibraryPin('tag', tagId, true)
    },
    async unpinTag(tagId: string) {
      return updateLibraryPin('tag', tagId, false)
    },
  },
  recentBooks: {
    get: loadRecentBooks,
    peek() {
      return recentBooksLoaded ? recentReading.snapshot() : undefined
    },
    beginSession(bookId: string, baselineCfi?: string) {
      recentReading.beginSession(bookId, baselineCfi)
    },
    cancelSession(bookId: string) {
      recentReading.cancelSession(bookId)
    },
    observePosition(bookId: string, cfi: string | undefined, userNavigation: boolean) {
      if (!recentReading.observePosition(bookId, cfi, userNavigation)) return false
      if (!recentBooksLoaded) recentBooksChangedDuringLoad = true
      notify('recentBooks')
      return true
    },
  },
  files: {
    reveal(path: string) {
      return invoke('reveal_exported_file', { path })
    },
    async getReaderSource(id: string): Promise<BookReaderSource> {
      const source = await invoke<NativeBookReaderSource>('get_book_reader_source', { id })
      if (source.book) {
        beginBooksMutation()
        rememberBook(source.book)
        notify('books')
      }
      return {
        mode: source.mode,
        url: filePathToUrl(source.path),
        rootUrl: source.rootPath ? filePathToUrl(source.rootPath) : undefined,
      }
    },
  },
  covers: {
    async toArray() {
      if (coversCache) return coversCache

      const covers = await invoke<CoverRecord[]>('list_covers', { ids: null })
      const normalized = covers.map(normalizeCoverRecord)
      rememberCovers(normalized)
      return normalized
    },
    peekAll() {
      return coversCache
    },
  },
}

export async function importEpubPaths(
  paths: string[],
  {
    importId,
    onProgress,
    replaceExisting = true,
  }: {
    importId?: string
    onProgress?: (progress: BookImportProgress) => void
    replaceExisting?: boolean
  } = {},
) {
  return importBooksWithProgress('import_epub_paths', { paths, replaceExisting }, importId, onProgress)
}

export async function openExternalEpubPaths(paths: string[]) {
  await waitForPendingNativeWrites()
  beginBooksMutation()
  const result = await trackNativeWrite(invoke<BookImportResult>('open_external_epub_paths', { paths }))
  result.books.forEach((book) => rememberBook(book))
  return result
}

export function getTextImportEncodings() {
  return invoke<TextImportEncodingOption[]>('get_text_import_encodings')
}

export async function previewTextImportPaths(paths: string[], encodings: Record<string, string> = {}) {
  return invoke<TextImportPreview[]>('preview_text_import_paths', {
    paths,
    encodings,
  })
}

export async function importTextPaths(
  imports: TextImportSelection[],
  {
    importId,
    onProgress,
    replaceExisting = true,
  }: {
    importId?: string
    onProgress?: (progress: BookImportProgress) => void
    replaceExisting?: boolean
  } = {},
) {
  return importBooksWithProgress('import_text_paths', { imports, replaceExisting }, importId, onProgress)
}

export function scanImportFolder(root: string, recursive: boolean) {
  return invoke<FolderImportCandidate[]>('scan_import_folder', { root, recursive })
}

export async function applyFolderImportTags(assignments: FolderImportTagAssignment[]) {
  if (!assignments.length) return { books: [], tags: tagsCache ?? [] }

  beginBooksMutation()
  const result = await trackNativeWrite(
    invoke<FolderImportTagResult>('apply_folder_import_tags', {
      assignments,
    }),
  )
  result.books.forEach(rememberBook)
  rememberTags(result.tags)
  notify('books', 'tags')
  return result
}

export function searchBookText(id: string, keyword: string, limit?: number) {
  return invoke<BookSearchResult[]>('search_book_text', {
    id,
    keyword,
    limit,
  })
}

export function loadBookImageIndex(id: string) {
  return invoke<BookImageIndexCache>('load_book_image_index', { id })
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
  beginBooksMutation()
  const result = await trackNativeWrite(
    invoke<BookTextReplaceResult>('replace_book_text', {
      id,
      target,
      oldText,
      newText,
    }),
  )
  rememberBook(result.book)
  notify('books')
  return result
}

export async function exportBook(id: string, format: BookExportFormat, outputPath: string) {
  beginBooksMutation()
  const book = await trackNativeWrite(invoke<BookRecord | null>('export_book', { id, format, outputPath }))
  if (book) {
    rememberBook(book)
    notify('books')
  }
  return book ?? undefined
}

export function setBookCacheActive(id: string, active: boolean) {
  return invoke<void>('set_book_cache_active', { id, active })
}

export async function clearBookCaches(
  discardUnexportedEdits: boolean,
  preservedUnpackedBookIds: string[],
  onProgress: (progress: BookCacheClearProgress) => void,
) {
  onProgress({ completed: 0, total: 0 })
  const progressChannel = new Channel<BookCacheClearProgress>(onProgress)

  beginBooksMutation()
  const books = await trackNativeWrite(
    invoke<BookRecord[]>('clear_book_caches', {
      discardUnexportedEdits,
      preservedUnpackedBookIds,
      onProgress: progressChannel,
    }),
  )
  const updatedBooks = books.map((book) => ({ ...book, contentEditedAt: undefined }))
  rememberBookBatch(updatedBooks)
  if (updatedBooks.length) notify('books')
  return updatedBooks
}

export function cleanupExternalBook(id: string) {
  return trackNativeWrite(invoke('cleanup_external_book', { id }))
}

export function cleanupAllExternalBooks() {
  return trackNativeWrite(invoke('cleanup_all_external_books'))
}

export function deleteExternalBook(id: string) {
  beginBooksMutation()
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
