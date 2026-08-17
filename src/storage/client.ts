import { Channel } from '@tauri-apps/api/core'

import { RecentReadingModel } from '../library/recentReading'

import { storagePathToUrl as filePathToUrl, invokeStorage as invoke } from './native'
import type {
  BookCacheClearProgress,
  BookExportFormat,
  BookImageIndexCache,
  BookImportProgress,
  BookImportResult,
  BookModeSwitchConflict,
  BookModeSwitchResolution,
  BookModeSwitchResult,
  BookReaderPreparation,
  BookReaderSource,
  BookRecord,
  BookSearchResult,
  BookSourceStatusRecord,
  BookStateCheckpointInput,
  BookTextReplaceResult,
  BookTextReplaceTarget,
  CoverRecord,
  FolderImportCandidate,
  FolderImportTagAssignment,
  FolderImportTagResult,
  LibraryPins,
  LibraryTagRecord,
  ReadingStatus,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportSelection,
} from './types'

interface NativeBookReaderPreparation {
  mode: BookReaderSource['mode']
  path: string
  rootPath?: string
  updatedBook?: BookRecord
  readingMetrics?: BookReaderSource['readingMetrics']
}

type Listener = () => void
type TableName = 'books' | 'covers' | 'pins' | 'recentBooks' | 'settings' | 'tags'

const listeners = new Map<TableName, Set<Listener>>()
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

function stripBookState(book: BookRecord): BookRecord {
  return { ...book, annotations: [], definitions: [], configuration: undefined }
}

function upsertCachedBook(book: BookRecord) {
  if (book.scope !== 'library' || !booksCache) return

  const cacheableBook = stripBookState(book)
  const cached = booksCache.find((candidate) => candidate.id === book.id)
  if (cached) Object.assign(cached, cacheableBook)
  else booksCache.push(cacheableBook)
  booksCache = [...booksCache]
}

function updateCachedBook(id: string, changes: Partial<BookRecord>) {
  const book = booksCache?.find((candidate) => candidate.id === id)
  if (book) Object.assign(book, changes)
}

function cacheBooks(books: BookRecord[]) {
  booksCache = books.filter((book) => book.scope === 'library').map(stripBookState)
}

function upsertCachedBooks(books: BookRecord[]) {
  if (!books.length || !booksCache) return

  const updates = new Map(
    books.filter((book) => book.scope === 'library').map((book) => [book.id, stripBookState(book)]),
  )
  if (!updates.size) return

  const seen = new Set<string>()
  const next = booksCache.map((book) => {
    const update = updates.get(book.id)
    if (!update) return book
    seen.add(book.id)
    return update
  })
  updates.forEach((book) => {
    if (!seen.has(book.id)) next.push(book)
  })
  booksCache = next
}

function forgetBooks(ids: string[]) {
  if (booksCache) {
    const removed = new Set(ids)
    booksCache = booksCache.filter((book) => !removed.has(book.id))
  }
}

function rememberCovers(covers: CoverRecord[]) {
  coversCache = covers.map(normalizeCoverRecord)
  return coversCache
}

function upsertCachedById<T extends { id: string }>(items: T[], value: T) {
  const index = items.findIndex((item) => item.id === value.id)
  return index >= 0 ? [...items.slice(0, index), value, ...items.slice(index + 1)] : [...items, value]
}

function rememberCover(cover: CoverRecord) {
  if (!coversCache) return
  coversCache = upsertCachedById(coversCache, normalizeCoverRecord(cover))
}

function forgetCovers(ids: string[]) {
  if (coversCache) {
    coversCache = coversCache.filter((cover) => !ids.includes(cover.id))
  }
}

function rememberTags(tags: LibraryTagRecord[]) {
  tagsCache = tags
}

function rememberTag(tag: LibraryTagRecord) {
  if (!tagsCache) return
  tagsCache = upsertCachedById(tagsCache, tag)
}

function applyDeletedTags(ids: string[], updatedAt: number) {
  const removed = new Set(ids)
  if (!removed.size) return

  const update = (book: BookRecord) => {
    const tagIds = book.tagIds ?? []
    return tagIds.some((tagId) => removed.has(tagId))
      ? { ...book, tagIds: tagIds.filter((tagId) => !removed.has(tagId)), updatedAt }
      : book
  }
  if (booksCache) {
    booksCache = booksCache.map(update)
  }
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

  cacheBooks(books)
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

function cacheBookImportProgress(progress: BookImportProgress) {
  if (!progress.book) return

  upsertCachedBook(progress.book)
  if (progress.cover) rememberCover(progress.cover)
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
    const progress = {
      ...nativeProgress,
      importId: importId ?? '',
    }
    if (progress.book) books.set(progress.book.id, progress.book)
    cacheBookImportProgress(progress)
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
    upsertCachedBook(book)
  })
  if (result.books.length && coversCache) {
    const fallbackCovers = await invoke<CoverRecord[]>('list_covers', {
      ids: result.books.map((book) => book.id),
    })
    fallbackCovers.forEach(rememberCover)
  }

  const importedBooks = [...books.values()]
  if (importedBooks.length) {
    invalidatePins()
    notify('books', 'covers', 'pins')
  }
  return { ...result, books: importedBooks }
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
      const book = await invoke<BookRecord | null>('get_book', { id })
      return book ?? undefined
    },
    peek(id: string) {
      return booksCache?.find((book) => book.id === id)
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
    updateCachedFields(
      id: string,
      changes: Partial<Pick<BookRecord, 'cfi' | 'lastReadAt' | 'percentage' | 'updatedAt'>>,
    ) {
      updateCachedBook(id, changes)
    },
    persistState(checkpoint: BookStateCheckpointInput) {
      return trackNativeWrite(invoke<void>('persist_book_state', { checkpoint }))
    },
    persistStateOnClose(checkpoint: BookStateCheckpointInput) {
      return trackNativeWrite(invoke<void>('persist_book_on_close', { checkpoint }))
    },
    async update(id: string, changes: Pick<BookRecord, 'metadata'>) {
      beginBooksMutation()
      const cached = booksCache?.find((book) => book.id === id)
      const committedChanges = { ...changes, updatedAt: Date.now() }
      if (cached) {
        updateCachedBook(id, committedChanges)
      }

      const updatedCover = await trackNativeWrite(
        invoke<CoverRecord | null>('update_book', {
          id,
          changes: committedChanges,
        }),
      )

      if (updatedCover) rememberCover(updatedCover)
      invalidatePins()
      notify(...(['books', updatedCover ? 'covers' : undefined, 'pins'].filter(Boolean) as TableName[]))
    },
    checkSourceStatuses(ids: string[]) {
      return invoke<BookSourceStatusRecord[]>('check_book_source_statuses', {
        ids,
      })
    },
    checkContentModeSwitch(id: string, editable: boolean) {
      return invoke<BookModeSwitchConflict | null>('check_book_content_mode_switch', { id, editable })
    },
    async switchContentMode(id: string, editable: boolean, resolution?: BookModeSwitchResolution) {
      beginBooksMutation()
      const result = await trackNativeWrite(
        invoke<BookModeSwitchResult>('switch_book_content_mode', { id, editable, resolution }),
      )
      if (result.book) {
        upsertCachedBook(result.book)
        notify('books')
      }
      return result
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
      const updatedAt = Date.now()
      const books = ids.flatMap((id) => {
        const book = booksCache?.find((book) => book.id === id)
        return book && book.readingStatus !== readingStatus ? [{ ...book, readingStatus, updatedAt }] : []
      })
      await trackNativeWrite(
        invoke<void>('update_book_reading_status', {
          ids,
          readingStatus,
        }),
      )
      upsertCachedBooks(books)
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
      const updatedAt = Date.now()
      const books = ids.flatMap((id) => {
        const book = booksCache?.find((book) => book.id === id)
        if (!book) return []

        const tagIds = new Set(book.tagIds ?? [])
        let changed = false
        for (const tagId of removals) {
          changed = tagIds.delete(tagId) || changed
        }
        for (const tagId of additions) {
          if (tagIds.has(tagId)) continue
          tagIds.add(tagId)
          changed = true
        }
        return changed ? [{ ...book, tagIds: [...tagIds], updatedAt }] : []
      })
      await trackNativeWrite(
        invoke<void>('update_book_tags', {
          ids,
          addTagIds: additions,
          removeTagIds: [...removals],
        }),
      )
      upsertCachedBooks(books)
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
      const updatedAt = Date.now()
      await trackNativeWrite(invoke<void>('delete_tags', { ids: uniqueIds }))
      applyDeletedTags(uniqueIds, updatedAt)
      invalidatePins()
      notify('tags', 'books', 'pins')
    },
    async merge(ids: string[], target: { id?: string; name?: string }) {
      beginBooksMutation()
      const sourceIds = [...new Set(ids.filter(Boolean))]
      const sourceIdSet = new Set(sourceIds)
      const updatedAt = Date.now()
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

        return { ...book, tagIds: [...tagIds.filter((tagId) => !sourceIdSet.has(tagId)), tag.id], updatedAt }
      }
      if (booksCache) {
        booksCache = booksCache.map(update)
      }
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
    record(bookId: string) {
      if (!recentReading.record(bookId)) return false
      if (!recentBooksLoaded) recentBooksChangedDuringLoad = true
      notify('recentBooks')
      return true
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
    async openReader(id: string): Promise<BookReaderPreparation> {
      const result = await invoke<NativeBookReaderPreparation>('get_book_reader_source', { id })
      const updatedBook = result.updatedBook
      if (updatedBook) {
        beginBooksMutation()
        upsertCachedBook(updatedBook)
        notify('books')
      }
      return {
        source: {
          mode: result.mode,
          url: filePathToUrl(result.path),
          rootUrl: result.rootPath ? filePathToUrl(result.rootPath) : undefined,
          readingMetrics: result.readingMetrics,
        },
        updatedBook,
      }
    },
    closeReader(id: string) {
      return invoke<void>('set_book_cache_active', { id, active: false })
    },
  },
  covers: {
    async toArray() {
      if (coversCache) return coversCache

      const covers = await invoke<CoverRecord[]>('list_covers', { ids: null })
      return rememberCovers(covers)
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
  }: {
    importId?: string
    onProgress?: (progress: BookImportProgress) => void
  } = {},
) {
  return importBooksWithProgress('import_epub_paths', { paths }, importId, onProgress)
}

export async function openExternalEpubPaths(paths: string[]) {
  await waitForPendingNativeWrites()
  beginBooksMutation()
  const result = await trackNativeWrite(invoke<BookImportResult>('open_external_epub_paths', { paths }))
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
    copySourceFiles,
    importId,
    onProgress,
  }: {
    copySourceFiles?: boolean
    importId?: string
    onProgress?: (progress: BookImportProgress) => void
  } = {},
) {
  return importBooksWithProgress('import_text_paths', { imports, copySourceFiles }, importId, onProgress)
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
  result.books.forEach(upsertCachedBook)
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
  upsertCachedBook(result.book)
  notify('books')
  return result
}

export async function exportBook(id: string, format: BookExportFormat, outputPath: string) {
  beginBooksMutation()
  const book = await trackNativeWrite(invoke<BookRecord | null>('export_book', { id, format, outputPath }))
  if (book) {
    upsertCachedBook(book)
    notify('books')
    return book
  }
  return undefined
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
  upsertCachedBooks(books)
  if (books.length) notify('books')
  return books
}

export function cleanupExternalBook(id: string) {
  return trackNativeWrite(invoke('cleanup_external_book', { id }))
}

export async function getSettingsFromStorage<T>() {
  return invoke<T>('get_settings')
}

export async function updateSettingsInStorage<T>(settings: T, flush: boolean) {
  await trackNativeWrite(invoke('update_settings', { settings, flush }))
  notify('settings')
}

export async function resetTextImportRuleInStorage(kind: string) {
  await trackNativeWrite(invoke('reset_text_import_rule', { kind }))
  notify('settings')
}

export async function flushSettingsInStorage() {
  await trackNativeWrite(invoke('flush_settings'))
}
