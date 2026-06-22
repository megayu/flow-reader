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
}

export interface TextImportRulesInput {
  groupPatterns: string[]
  chapterPatterns: string[]
}

export interface ReadingSpreadPageRecord {
  sectionIndex: number
  pageIndex: number
}

export interface ReadingSpreadRecord extends ReadingSpreadPageRecord {
  version: 1
  anchor: 'left' | 'right'
  layoutStyleSignature?: string
}

export type ReadingStatus = 'toRead' | 'reading' | 'read'

export interface BookRecord {
  id: string
  name: string
  size: number
  readingStatus?: ReadingStatus | null
  metadata: PackagingMetadataObject
  createdAt: number
  updatedAt?: number
  lastReadAt?: number
  cfi?: string
  percentage?: number
  definitions: string[]
  annotations: Annotation[]
  configuration?: {
    typography?: TypographyConfiguration
    spread?: ReadingSpreadRecord
  }
  contentHash?: string
  contentVersion?: number
  stateLoaded?: boolean
}

type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>

type Listener = () => void
type TableName = 'books' | 'covers' | 'files' | 'settings'

const listeners = new Map<TableName, Set<Listener>>()
const bookCache = new Map<string, BookRecord>()
let booksCache: BookRecord[] | undefined
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
  const normalized = full ? asFullBook(book) : asBookSummary(book)
  bookCache.set(book.id, normalized)

  if (!booksCache) return

  const index = booksCache.findIndex((item) => item.id === book.id)
  if (index >= 0) {
    booksCache = [
      ...booksCache.slice(0, index),
      normalized,
      ...booksCache.slice(index + 1),
    ]
  } else {
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

function isReadingPositionOnlyUpdate(changes: Partial<BookRecord>) {
  const keys = Object.keys(changes)
  return (
    keys.length > 0 &&
    keys.some((key) => key === 'cfi' || key === 'percentage') &&
    keys.every((key) =>
      ['cfi', 'percentage', 'updatedAt', 'lastReadAt'].includes(key),
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

function addCacheBuster(url: string) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`
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
    remember(book: BookRecord) {
      rememberBook(book)
    },
    async update(id: string, changes: Partial<BookRecord>) {
      const cached = bookCache.get(id)
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

      if (!isReadingPositionOnlyUpdate(changes)) {
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
      notify('books', 'covers', 'files')
    },
    async delete(id: string) {
      await this.bulkDelete([id])
    },
  },
  files: {
    async getPackageUrl(id: string) {
      const path = await invoke<string>('get_book_package_path', { id })
      return filePathToUrl(path)
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
      const covers = await invoke<CoverRecord[]>('list_covers')
      return Promise.all(
        covers.map(async (cover) => ({
          ...cover,
          cover: cover.cover
            ? addCacheBuster(await filePathToUrl(cover.cover))
            : null,
        })),
      )
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
  { replaceExisting = true }: { replaceExisting?: boolean } = {},
) {
  const books = await trackNativeWrite(
    invoke<BookRecord[]>('import_epub_paths', {
      paths,
      replaceExisting,
    }),
  )
  books.forEach((book) => rememberBook(book))
  notify('books', 'covers', 'files')
  return books
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
  notify('books', 'covers', 'files')
  return books
}

export async function getSettingsFromStorage<T>() {
  return invoke<T>('get_settings')
}

export async function updateSettingsInStorage<T>(settings: T) {
  await trackNativeWrite(invoke('update_settings', { settings }))
  notify('settings')
}
