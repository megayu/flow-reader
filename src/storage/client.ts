import { storagePathToUrl as filePathToUrl, invokeStorage as invoke } from './native'
import type {
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
  CoverInput,
  CoverRecord,
  LibraryPins,
  LibraryTagRecord,
  ReadingPositionInput,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportRulesInput,
  TextImportSelection,
} from './types'

interface NativeBookReaderSource {
  mode: BookReaderSource['mode']
  path: string
  rootPath?: string
  book?: BookRecord
}

type Listener = () => void
type TableName = 'books' | 'covers' | 'files' | 'pins' | 'settings' | 'tags'

const listeners = new Map<TableName, Set<Listener>>()
const bookCache = new Map<string, BookRecord>()
let booksCache: BookRecord[] | undefined
let booksCacheEpoch = 0
let booksListPromise: Promise<BookRecord[]> | undefined
let coversCache: CoverRecord[] | undefined
let tagsCache: LibraryTagRecord[] | undefined
let pinsCache: LibraryPins | undefined
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
  const normalized = full ? asFullBook(book) : mergeBookSummary(book, bookCache.get(book.id))
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

function rememberBookBatch(books: BookRecord[], { full = true } = {}) {
  if (!books.length) return

  const normalized = books.map((book) => (full ? asFullBook(book) : mergeBookSummary(book, bookCache.get(book.id))))
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
  booksCache = books.map((book) => mergeBookSummary(book, bookCache.get(book.id)))
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

async function refreshImportedCovers(ids: string[]) {
  if (!coversCache || !ids.length) return

  const covers = await invoke<CoverRecord[]>('list_covers', { ids })
  const normalized = covers.map(normalizeCoverRecord)
  const updates = new Map(normalized.map((cover) => [cover.id, cover]))
  const next = coversCache.map((cover) => updates.get(cover.id) ?? cover)
  const existing = new Set(next.map((cover) => cover.id))
  normalized.forEach((cover) => {
    if (!existing.has(cover.id)) {
      existing.add(cover.id)
      next.push(cover)
    }
  })
  coversCache = next
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

function forgetTag(id: string) {
  if (tagsCache) {
    tagsCache = tagsCache.filter((tag) => tag.id !== id)
  }
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

function toCoverRecord(record: CoverRecord | null) {
  if (!record) return undefined
  return normalizeCoverRecord(record)
}

export function rememberBookImportProgress(progress: BookImportProgress) {
  if (!progress.book) return

  beginBooksMutation()
  rememberBook(progress.book)
  if (progress.cover) rememberCover(normalizeCoverRecord(progress.cover))
  notify('books', ...(progress.cover ? (['covers'] as const) : []))
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
      return loadBooks()
    },
    async get(id: string): Promise<BookRecord | undefined> {
      const cached = bookCache.get(id)
      if (cached?.stateLoaded) return Promise.resolve(cached)

      const requestEpoch = booksCacheEpoch
      const book = await invoke<BookRecord | null>('get_book', { id })
      if (requestEpoch !== booksCacheEpoch) return db.books.get(id)
      if (!book) return undefined

      const loadedBook = asFullBook(book)
      rememberBook(loadedBook)
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
      rememberBook({ ...base, ...changes }, { full: base.stateLoaded !== false })
    },
    recordReadingPosition(position: ReadingPositionInput) {
      return trackNativeWrite(invoke<boolean>('record_reading_position', { position }))
    },
    async update(id: string, changes: Partial<BookRecord>) {
      beginBooksMutation()
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
        if (changes.metadata) invalidatePins()
        notify(
          ...(['books', changes.metadata ? 'covers' : undefined, changes.metadata ? 'pins' : undefined].filter(
            Boolean,
          ) as TableName[]),
        )
      }
      return book ?? undefined
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
      notify('books', 'covers', 'files', 'pins')
    },
    async delete(id: string) {
      await this.bulkDelete([id])
    },
    async updateTags(
      ids: string[],
      { addTagIds = [], removeTagIds = [] }: { addTagIds?: string[]; removeTagIds?: string[] },
    ) {
      beginBooksMutation()
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
      beginBooksMutation()
      const books = await trackNativeWrite(invoke<BookRecord[]>('delete_tag', { id }))
      forgetTag(id)
      books.forEach((book) => rememberBook(book, { full: false }))
      invalidatePins()
      notify('tags', 'books', 'pins')
      return books
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
  files: {
    reveal(path: string) {
      return invoke('reveal_exported_file', { path })
    },
    async getPackageUrl(id: string) {
      const path = await invoke<string>('get_book_package_path', { id })
      return filePathToUrl(path)
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

      const covers = await invoke<CoverRecord[]>('list_covers', { ids: null })
      const normalized = covers.map(normalizeCoverRecord)
      rememberCovers(normalized)
      return normalized
    },
    peekAll() {
      return coversCache
    },
    get(id: string) {
      return invoke<CoverRecord | null>('get_cover', { id }).then((cover) => toCoverRecord(cover))
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

export async function importEpubPaths(
  paths: string[],
  {
    importId,
    progressiveUpdates = false,
    replaceExisting = true,
  }: { importId?: string; progressiveUpdates?: boolean; replaceExisting?: boolean } = {},
) {
  await waitForPendingNativeWrites()
  beginBooksMutation()
  const result = await trackNativeWrite(
    invoke<BookImportResult>('import_epub_paths', {
      importId,
      paths,
      replaceExisting,
    }),
  )
  rememberBookBatch(result.books)
  if (result.books.length) {
    invalidatePins()
    if (!progressiveUpdates) await refreshImportedCovers(result.books.map((book) => book.id))
    notify('books', 'covers', 'files', 'pins')
  }
  return result
}

export async function openExternalEpubPaths(paths: string[]) {
  beginBooksMutation()
  const result = await trackNativeWrite(invoke<BookImportResult>('open_external_epub_paths', { paths }))
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
    importId,
    progressiveUpdates = false,
    replaceExisting = true,
    rules,
  }: {
    importId?: string
    progressiveUpdates?: boolean
    replaceExisting?: boolean
    rules?: TextImportRulesInput
  } = {},
) {
  await waitForPendingNativeWrites()
  beginBooksMutation()
  const result = await trackNativeWrite(
    invoke<BookImportResult>('import_text_paths', {
      importId,
      imports,
      replaceExisting,
      rules,
    }),
  )
  rememberBookBatch(result.books)
  if (result.books.length) {
    invalidatePins()
    if (!progressiveUpdates) await refreshImportedCovers(result.books.map((book) => book.id))
    notify('books', 'covers', 'files', 'pins')
  }
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
  notify('books', 'files')
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
