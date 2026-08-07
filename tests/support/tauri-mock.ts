import type { Page } from '@playwright/test'

import type { LocalDictionaryRecord } from '../../src/dictionary/native'
import type { WindowUiState } from '../../src/state'
import type {
  BookRecord,
  BookSourceStatus,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportSelection,
} from '../../src/storage'

export interface TestLibraryTagRecord {
  id: string
  name: string
  createdAt: number
  updatedAt?: number
}

export interface TestLibraryPins {
  authors: string[]
  tagIds: string[]
}

const testWindowUiState: WindowUiState = {
  librarySidebarOpen: true,
  librarySidebarWidth: 240,
  panes: {},
  readerSidebarOpen: true,
  readerSidebarWidth: 240,
}

interface TauriMockOptions {
  books?: BookRecord[]
  eventListenDelayMs?: number
  externallyOpenedBooks?: BookRecord[]
  importedBooks?: BookRecord[]
  epubImportDelayMs?: number
  localDictionaries?: LocalDictionaryRecord[]
  localDictionaryFiles?: Record<string, LocalDictionaryRecord | { code: string; message: string }>
  openDialogPaths?: string[]
  pendingOpenPaths?: string[]
  pendingOpenPathsError?: string
  pins?: TestLibraryPins
  deferReaderSource?: boolean
  readerSourceErrors?: Record<string, string>
  readerSources?: Record<string, string>
  revealableBookSourceIds?: string[]
  sourceStatuses?: Record<string, BookSourceStatus>
  saveDialogPath?: string | null
  settings?: Record<string, unknown>
  tags?: TestLibraryTagRecord[]
  textImportEncodings?: TextImportEncodingOption[]
  textImportDelayMs?: number
  textImportPreviewDelayMs?: number
  textImportPreviews?: TextImportPreview[]
  merriamWebsterResponses?: Record<string, unknown>
  mdictResponses?: Record<string, Record<string, unknown>>
  mdictStylesheets?: Record<string, Record<string, string>>
  stardictResponses?: Record<string, Record<string, unknown>>
  zdicResponses?: Record<string, string>
  zdicResponseSequences?: Record<string, string[]>
  zdicResponseStatuses?: Record<string, number>
  zdicResponseDelayMs?: number
  translationResponseDelayMs?: number
  translationError?: string
}

export async function installTauriMock(
  page: Page,
  {
    books = [],
    eventListenDelayMs = 0,
    externallyOpenedBooks = [],
    importedBooks = [],
    epubImportDelayMs = 0,
    localDictionaries = [],
    localDictionaryFiles = {},
    openDialogPaths = [],
    pendingOpenPaths = [],
    pendingOpenPathsError,
    pins = { authors: [], tagIds: [] },
    deferReaderSource = false,
    readerSourceErrors = {},
    readerSources = {},
    revealableBookSourceIds = [],
    sourceStatuses = {},
    saveDialogPath = null,
    settings = {},
    tags = [],
    textImportEncodings = [
      { id: 'auto', label: 'Auto' },
      { id: 'utf-8', label: 'UTF-8' },
      { id: 'gb18030', label: 'GB18030' },
    ],
    textImportDelayMs = 0,
    textImportPreviewDelayMs = 0,
    textImportPreviews = [],
    merriamWebsterResponses = {},
    mdictResponses = {},
    mdictStylesheets = {},
    stardictResponses = {},
    zdicResponses = {},
    zdicResponseSequences = {},
    zdicResponseStatuses = {},
    zdicResponseDelayMs = 0,
    translationResponseDelayMs = 0,
    translationError,
  }: TauriMockOptions = {},
) {
  await page.addInitScript(
    ({
      fixtureBooks,
      fixtureEventListenDelayMs,
      fixtureExternallyOpenedBooks,
      fixtureImportedBooks,
      fixtureEpubImportDelayMs,
      fixtureLocalDictionaries,
      fixtureLocalDictionaryFiles,
      fixtureOpenDialogPaths,
      fixturePendingOpenPaths,
      fixturePendingOpenPathsError,
      fixturePins,
      fixtureDeferReaderSource,
      fixtureReaderSourceErrors,
      fixtureReaderSources,
      fixtureRevealableBookSourceIds,
      fixtureSourceStatuses,
      fixtureSaveDialogPath,
      fixtureSettings,
      fixtureTags,
      fixtureTextImportEncodings,
      fixtureTextImportDelayMs,
      fixtureTextImportPreviewDelayMs,
      fixtureTextImportPreviews,
      fixtureMerriamWebsterResponses,
      fixtureMdictResponses,
      fixtureMdictStylesheets,
      fixtureStardictResponses,
      fixtureZdicResponses,
      fixtureZdicResponseSequences,
      fixtureZdicResponseStatuses,
      fixtureZdicResponseDelayMs,
      fixtureTranslationResponseDelayMs,
      fixtureTranslationError,
      fixtureWindowUiState,
    }) => {
      type TauriInternals = {
        callbacks?: Record<number, (...args: unknown[]) => unknown>
        convertFileSrc?: (filePath: string) => string
        invoke?: (command: string, args?: Record<string, unknown>) => unknown
        metadata?: {
          currentWebview: { label: string }
          currentWindow: { label: string }
        }
        runCallback?: (id: number, ...args: unknown[]) => unknown
        transformCallback?: (callback: (...args: unknown[]) => unknown) => number
        unregisterCallback?: (id: number) => void
      }
      type TauriEventInternals = {
        unregisterListener?: (event: string, eventId: number) => void
      }

      const globalWindow = window as typeof window & {
        __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventInternals
        __FLOW_TEST_TAURI__?: {
          exports: Array<{
            format: string
            id: string
            outputPath: string
          }>
          fullscreen: boolean
          cancelledDictionarySessions: number[]
          dictionaryRequests: Array<{ query: string; sessionId: number }>
          dialogOpenCalls: unknown[]
          merriamWebsterRequests: Array<{ query: string; sessionId: number }>
          mdictRequests: Array<{
            dictionaryId: string
            query: string
            sessionId: number
          }>
          mdictStylesheetRequests: Array<{
            dictionaryId: string
            key: string
            sessionId: number
          }>
          stardictRequests: Array<{
            dictionaryId: string
            query: string
            sessionId: number
          }>
          localDictionaries: LocalDictionaryRecord[]
          libraryPinsStore: TestLibraryPins
          bookImportOperations: string[]
          openedExternalUrls: string[]
          revealedBookSourceIds: string[]
          takePendingOpenPathsCalls: number
          settingsStore: Record<string, unknown>
          textImports: TextImportSelection[]
        }
        __TAURI_INTERNALS__?: TauriInternals
      }
      const settingsStorageKey = '__FLOW_TEST_TAURI_SETTINGS__'
      const libraryPinsStorageKey = '__FLOW_TEST_TAURI_LIBRARY_PINS__'
      const storedSettings = (() => {
        try {
          return JSON.parse(localStorage.getItem(settingsStorageKey) ?? '{}') as Record<string, unknown> | undefined
        } catch {
          return undefined
        }
      })()
      const storedLibraryPins = (() => {
        try {
          return JSON.parse(localStorage.getItem(libraryPinsStorageKey) ?? 'null') as TestLibraryPins | null
        } catch {
          return null
        }
      })()
      const bookStore = new Map<string, BookRecord>(fixtureBooks.map((book) => [book.id, book]))
      const tagStore = new Map<string, TestLibraryTagRecord>(fixtureTags.map((tag) => [tag.id, tag]))
      const libraryPinsStore: TestLibraryPins = {
        authors: [...(storedLibraryPins?.authors ?? fixturePins.authors)],
        tagIds: [...(storedLibraryPins?.tagIds ?? fixturePins.tagIds)],
      }
      const persistLibraryPins = () => {
        localStorage.setItem(libraryPinsStorageKey, JSON.stringify(libraryPinsStore))
      }
      const prunePinnedAuthors = () => {
        const authors = new Set(
          Array.from(bookStore.values())
            .map((book) =>
              String(book.metadata.creator ?? '')
                .replace(/\s+/g, ' ')
                .trim(),
            )
            .filter(Boolean),
        )
        libraryPinsStore.authors = libraryPinsStore.authors.filter((author) => authors.has(author))
        persistLibraryPins()
      }
      const importQueue = [...fixtureImportedBooks]
      const externalOpenQueue = [...fixtureExternallyOpenedBooks]
      const localDictionaryStore = fixtureLocalDictionaries.map((record) => ({
        ...record,
      }))
      const textImportPreviewStore = new Map<string, TextImportPreview>(
        fixtureTextImportPreviews.map((preview) => [preview.path, preview]),
      )
      const settingsStore: Record<string, unknown> = {
        locale: 'en-US',
        ...(storedSettings ?? {}),
        ...fixtureSettings,
      }
      let fullscreen = false
      let nextCallbackId = 1
      let nextEventId = 1

      const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
      const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {})
      const callbacks = (internals.callbacks ??= {})

      globalWindow.__FLOW_TEST_TAURI__ = {
        bookImportOperations: [],
        cancelledDictionarySessions: [],
        dictionaryRequests: [],
        dialogOpenCalls: [],
        merriamWebsterRequests: [],
        mdictRequests: [],
        mdictStylesheetRequests: [],
        stardictRequests: [],
        localDictionaries: localDictionaryStore,
        libraryPinsStore,
        exports: [],
        get fullscreen() {
          return fullscreen
        },
        takePendingOpenPathsCalls: 0,
        settingsStore,
        openedExternalUrls: [],
        revealedBookSourceIds: [],
        textImports: [],
      }
      internals.metadata = {
        currentWebview: { label: 'main' },
        currentWindow: { label: 'main' },
      }
      internals.convertFileSrc = (filePath) => filePath
      internals.transformCallback = (callback) => {
        const id = nextCallbackId++
        callbacks[id] = callback
        return id
      }
      internals.unregisterCallback = (id) => {
        delete callbacks[id]
      }
      internals.runCallback = (id, ...args) => callbacks[id]?.(...args)
      eventInternals.unregisterListener = () => undefined
      internals.invoke = async (command, args) => {
        if (command === 'fetch_translation') {
          if (fixtureTranslationResponseDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureTranslationResponseDelayMs))
          }
          if (fixtureTranslationError) {
            throw {
              code: 'translation_error',
              message: fixtureTranslationError,
            }
          }
          const request = (args?.request ?? {}) as {
            provider?: string
            texts?: string[]
          }
          const texts = request.texts ?? []
          return {
            bodies:
              request.provider === 'azure'
                ? [
                    JSON.stringify(
                      texts.map((text) => ({
                        translations: [{ text: `Azure: ${text}`, to: 'en' }],
                      })),
                    ),
                  ]
                : texts.map((text) => JSON.stringify([[[`Google: ${text}`, text]]])),
          }
        }
        if (command === 'cancel_translation_session') return null
        if (command === 'fetch_zdic') {
          const query = String(args?.query ?? '')
          const sessionId = Number(args?.sessionId ?? 0)
          globalWindow.__FLOW_TEST_TAURI__?.dictionaryRequests.push({
            query,
            sessionId,
          })
          if (fixtureZdicResponseDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureZdicResponseDelayMs))
          }
          const status = fixtureZdicResponseStatuses[query] ?? 200
          if (status >= 400) {
            throw {
              code: status === 404 ? 'not_found' : 'http_status',
              message: `Dictionary service returned HTTP ${status}`,
            }
          }
          return {
            body: fixtureZdicResponseSequences[query]?.shift() ?? fixtureZdicResponses[query] ?? '',
            finalUrl: `https://zdic.net/hans/${encodeURIComponent(query)}`,
            status: 200,
          }
        }
        if (command === 'fetch_merriam_webster') {
          const query = String(args?.query ?? '')
          const sessionId = Number(args?.sessionId ?? 0)
          globalWindow.__FLOW_TEST_TAURI__?.merriamWebsterRequests.push({
            query,
            sessionId,
          })
          return {
            body: JSON.stringify(fixtureMerriamWebsterResponses[query] ?? []),
            finalUrl: `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(query)}`,
            status: 200,
          }
        }
        if (command === 'lookup_stardict') {
          const dictionaryId = String(args?.dictionaryId ?? '')
          const query = String(args?.query ?? '')
          const sessionId = Number(args?.sessionId ?? 0)
          globalWindow.__FLOW_TEST_TAURI__?.stardictRequests.push({
            dictionaryId,
            query,
            sessionId,
          })
          return (
            fixtureStardictResponses[dictionaryId]?.[query] ?? {
              entries: [],
            }
          )
        }
        if (command === 'lookup_mdict') {
          const dictionaryId = String(args?.dictionaryId ?? '')
          const query = String(args?.query ?? '')
          const sessionId = Number(args?.sessionId ?? 0)
          globalWindow.__FLOW_TEST_TAURI__?.mdictRequests.push({
            dictionaryId,
            query,
            sessionId,
          })
          const response = fixtureMdictResponses[dictionaryId]?.[query]
          if (!response) {
            return {
              entry: null,
              resourceUrlPrefix: `http://dictionary.localhost/${sessionId}/${encodeURIComponent(dictionaryId)}/`,
            }
          }
          return {
            ...(response as Record<string, unknown>),
            resourceUrlPrefix: `http://dictionary.localhost/${sessionId}/${encodeURIComponent(dictionaryId)}/`,
          }
        }
        if (command === 'load_mdict_stylesheet') {
          const dictionaryId = String(args?.dictionaryId ?? '')
          const key = String(args?.key ?? '')
          const sessionId = Number(args?.sessionId ?? 0)
          globalWindow.__FLOW_TEST_TAURI__?.mdictStylesheetRequests.push({
            dictionaryId,
            key,
            sessionId,
          })
          const text = fixtureMdictStylesheets[dictionaryId]?.[key]
          return text === undefined ? null : { key, text }
        }
        if (command === 'cancel_dictionary_session') {
          globalWindow.__FLOW_TEST_TAURI__?.cancelledDictionarySessions.push(Number(args?.sessionId ?? 0))
          return null
        }
        if (command === 'list_local_dictionaries') {
          return [...localDictionaryStore].sort((left, right) => left.order - right.order)
        }
        if (command === 'register_local_dictionary') {
          const path = String(args?.path ?? '')
          const fixture = fixtureLocalDictionaryFiles[path]
          if (!fixture || 'code' in fixture) {
            throw (
              fixture ?? {
                code: 'unsupportedMasterFile',
                message: 'Choose a StarDict .ifo or MDict .mdx master file.',
              }
            )
          }
          const index = localDictionaryStore.findIndex((record) => record.sourcePath === path)
          if (index >= 0) {
            localDictionaryStore[index] = {
              ...fixture,
              id: localDictionaryStore[index]!.id,
            }
            return localDictionaryStore[index]
          }
          localDictionaryStore.push({ ...fixture })
          return fixture
        }
        if (command === 'update_local_dictionary') {
          const id = String(args?.id ?? '')
          const index = localDictionaryStore.findIndex((record) => record.id === id)
          if (index < 0) throw new Error('Dictionary not found')
          const changes = (args?.changes ?? {}) as {
            enabled?: boolean
            language?: LocalDictionaryRecord['language']['value']
            name?: string
            order?: number
          }
          const current = localDictionaryStore[index]!
          const updated: LocalDictionaryRecord = {
            ...current,
            ...(typeof changes.enabled === 'boolean' ? { enabled: changes.enabled } : {}),
            ...(typeof changes.order === 'number' ? { order: changes.order } : {}),
            ...(typeof changes.name === 'string' ? { name: changes.name.trim() } : {}),
            ...(changes.language
              ? {
                  language: {
                    source: 'manual' as const,
                    value: changes.language,
                  },
                }
              : {}),
          }
          localDictionaryStore[index] = updated
          return updated
        }
        if (command === 'relocate_local_dictionary') {
          const id = String(args?.id ?? '')
          const path = String(args?.path ?? '')
          const index = localDictionaryStore.findIndex((record) => record.id === id)
          const fixture = fixtureLocalDictionaryFiles[path]
          if (index < 0 || !fixture || 'code' in fixture) {
            throw fixture && 'code' in fixture ? fixture : new Error('Dictionary cannot be relocated')
          }
          const current = localDictionaryStore[index]!
          localDictionaryStore[index] = {
            ...fixture,
            enabled: current.enabled,
            id,
            language: current.language,
            order: current.order,
          }
          return localDictionaryStore[index]
        }
        if (command === 'remove_local_dictionary') {
          const id = String(args?.id ?? '')
          const index = localDictionaryStore.findIndex((record) => record.id === id)
          if (index >= 0) localDictionaryStore.splice(index, 1)
          return null
        }
        if (command === 'open_external_url') {
          globalWindow.__FLOW_TEST_TAURI__?.openedExternalUrls.push(String(args?.url ?? ''))
          return null
        }
        if (command === 'get_settings') return { ...settingsStore }
        if (command === 'update_settings') {
          Object.assign(settingsStore, args?.settings ?? {})
          localStorage.setItem(settingsStorageKey, JSON.stringify(settingsStore))
          return null
        }
        if (command === 'list_books') return Array.from(bookStore.values())
        if (command === 'list_tags') return Array.from(tagStore.values())
        if (command === 'get_library_pins') return structuredClone(libraryPinsStore)
        if (command === 'update_library_pin') {
          const kind = String(args?.kind ?? '')
          const id = String(args?.id ?? '')
            .replace(/\s+/g, ' ')
            .trim()
          const pinned = Boolean(args?.pinned)
          const items = kind === 'author' ? libraryPinsStore.authors : libraryPinsStore.tagIds
          const exists =
            kind === 'author'
              ? Array.from(bookStore.values()).some(
                  (book) =>
                    String(book.metadata.creator ?? '')
                      .replace(/\s+/g, ' ')
                      .trim() === id,
                )
              : kind === 'tag' && tagStore.has(id)
          if (id && (!pinned || exists)) {
            const updated = items.filter((item) => item !== id)
            if (pinned) updated.unshift(id)
            if (kind === 'author') libraryPinsStore.authors = updated
            if (kind === 'tag') libraryPinsStore.tagIds = updated
          }
          persistLibraryPins()
          return structuredClone(libraryPinsStore)
        }
        if (command === 'create_tag') {
          const name = String(args?.name ?? '')
            .replace(/\s+/g, ' ')
            .trim()
          if (!name) return null
          const existing = Array.from(tagStore.values()).find((tag) => tag.name.toLowerCase() === name.toLowerCase())
          if (existing) return existing

          const tag = {
            id: `tag-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
            name,
            createdAt: Date.now(),
          }
          tagStore.set(tag.id, tag)
          return tag
        }
        if (command === 'update_tag') {
          const id = String(args?.id)
          const current = tagStore.get(id)
          if (!current) return null
          const name = String(args?.name ?? current.name)
            .replace(/\s+/g, ' ')
            .trim()
          if (!name) return current

          const duplicate = Array.from(tagStore.values()).find(
            (tag) => tag.id !== id && tag.name.toLowerCase() === name.toLowerCase(),
          )
          if (duplicate) return current

          const updated = { ...current, name, updatedAt: Date.now() }
          tagStore.set(id, updated)
          return updated
        }
        if (command === 'delete_tag') {
          const id = String(args?.id)
          tagStore.delete(id)
          libraryPinsStore.tagIds = libraryPinsStore.tagIds.filter((tagId) => tagId !== id)
          persistLibraryPins()
          bookStore.forEach((book, bookId) => {
            const tagIds = ((book as BookRecord & { tagIds?: string[] }).tagIds ?? []).filter((tagId) => tagId !== id)
            bookStore.set(bookId, { ...book, tagIds })
          })
          return Array.from(bookStore.values())
        }
        if (command === 'update_book_tags') {
          const ids = Array.isArray(args?.ids) ? args.ids.map(String) : []
          const addTagIds = Array.isArray(args?.addTagIds) ? args.addTagIds.map(String) : []
          const removeTagIds = Array.isArray(args?.removeTagIds) ? args.removeTagIds.map(String) : []
          const updatedBooks: BookRecord[] = []

          ids.forEach((id) => {
            const current = bookStore.get(id)
            if (!current) return

            const tagIds = new Set((current as BookRecord & { tagIds?: string[] }).tagIds ?? [])
            removeTagIds.forEach((tagId) => tagIds.delete(tagId))
            addTagIds.forEach((tagId) => tagIds.add(tagId))

            const updated = { ...current, tagIds: Array.from(tagIds) }
            bookStore.set(id, updated)
            updatedBooks.push(updated)
          })

          return updatedBooks
        }
        if (command === 'get_book') return bookStore.get(String(args?.id)) ?? null
        if (command === 'reveal_book_source') {
          const id = String(args?.id)
          if (!fixtureRevealableBookSourceIds.includes(id)) return false
          globalWindow.__FLOW_TEST_TAURI__?.revealedBookSourceIds.push(id)
          return true
        }
        if (command === 'check_book_source_statuses') {
          const ids = Array.isArray(args?.ids) ? args.ids.map(String) : []
          return ids.map((id) => ({
            id,
            status: fixtureSourceStatuses[id] ?? 'available',
          }))
        }
        if (command === 'get_book_reader_source' && fixtureDeferReaderSource) {
          return new Promise(() => undefined)
        }
        if (command === 'get_book_reader_source') {
          const id = String(args?.id)
          const message = fixtureReaderSourceErrors[id]
          if (message) throw new Error(message)
        }
        if (command === 'get_book_package_path') {
          return fixtureReaderSources[String(args?.id)] ?? null
        }
        if (command === 'get_book_reader_source') {
          const path = fixtureReaderSources[String(args?.id)] ?? ''
          return path
            ? {
                mode: path.toLowerCase().endsWith('.epub') ? 'epub' : 'opf',
                path,
              }
            : null
        }
        if (command === 'update_book') {
          const id = String(args?.id)
          const current = bookStore.get(id)
          if (!current) return null

          const updated = {
            ...current,
            ...((args?.changes ?? {}) as Partial<BookRecord>),
          }
          bookStore.set(id, updated)
          if ((args?.changes as Partial<BookRecord> | undefined)?.metadata) prunePinnedAuthors()
          return updated
        }
        if (command === 'delete_books') {
          const ids = Array.isArray(args?.ids) ? args.ids : []
          ids.forEach((id) => bookStore.delete(String(id)))
          prunePinnedAuthors()
          return null
        }
        if (command === 'import_epub_paths') {
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('epub:start')
          if (fixtureEpubImportDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureEpubImportDelayMs))
          }
          const paths = Array.isArray(args?.paths) ? args.paths : []
          const imported = importQueue.splice(0, Math.max(paths.length, 1))
          imported.forEach((book) => bookStore.set(book.id, book))
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('epub:finish')
          return {
            books: imported,
            failures: [],
          }
        }
        if (command === 'open_external_epub_paths') {
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('epub:start')
          if (fixtureEpubImportDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureEpubImportDelayMs))
          }
          const paths = Array.isArray(args?.paths) ? args.paths : []
          const opened = externalOpenQueue.splice(0, Math.max(paths.length, 1))
          opened.forEach((book) => bookStore.set(book.id, book))
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('epub:finish')
          return { books: opened, failures: [] }
        }
        if (command === 'get_text_import_encodings') {
          return fixtureTextImportEncodings
        }
        if (command === 'preview_text_import_paths') {
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('txt-preview:start')
          if (fixtureTextImportPreviewDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureTextImportPreviewDelayMs))
          }
          const paths = Array.isArray(args?.paths) ? args.paths.map(String) : []
          const previews = paths.map((path) => {
            const preview = textImportPreviewStore.get(path)
            if (preview) return preview

            const filename = path.split(/[\\/]/).pop() ?? 'book.txt'
            const title = filename.replace(/\.[^.]+$/, '') || filename
            return {
              path,
              filename,
              title,
              encoding: 'utf-8',
              encodingLabel: 'UTF-8',
              confidence: 'high',
              status: 'ready',
              selected: true,
              chapters: [],
              sample: '',
            }
          })
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('txt-preview:finish')
          return previews
        }
        if (command === 'import_text_paths') {
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('txt-import:start')
          if (fixtureTextImportDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureTextImportDelayMs))
          }
          const imports = Array.isArray(args?.imports) ? (args.imports as TextImportSelection[]) : []
          globalWindow.__FLOW_TEST_TAURI__?.textImports.push(...imports)
          const imported = importQueue.splice(0, Math.max(imports.length, 1))
          imported.forEach((book) => bookStore.set(book.id, book))
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('txt-import:finish')
          return { books: imported, failures: [] }
        }
        if (command === 'export_book') {
          const id = String(args?.id)
          const format = String(args?.format)
          const outputPath = String(args?.outputPath ?? '')
          const current = bookStore.get(id)
          if (!current) return null

          globalWindow.__FLOW_TEST_TAURI__?.exports.push({
            format,
            id,
            outputPath,
          })
          const updated = {
            ...current,
            contentEditedAt: undefined,
          }
          bookStore.set(id, updated)
          return updated
        }
        if (command === 'list_covers') return []
        if (command === 'get_cover') return null
        if (command === 'take_pending_open_paths') {
          if (globalWindow.__FLOW_TEST_TAURI__) {
            globalWindow.__FLOW_TEST_TAURI__.takePendingOpenPathsCalls += 1
          }
          if (fixturePendingOpenPathsError) throw new Error(fixturePendingOpenPathsError)
          return fixturePendingOpenPaths
        }
        if (command === 'get_window_ui_state') return fixtureWindowUiState
        if (command === 'plugin:dialog|open') {
          globalWindow.__FLOW_TEST_TAURI__?.dialogOpenCalls.push(args ?? {})
          const options = args?.options as { multiple?: boolean } | undefined
          return options?.multiple === false ? (fixtureOpenDialogPaths[0] ?? null) : fixtureOpenDialogPaths
        }
        if (command === 'plugin:dialog|save') return fixtureSaveDialogPath
        if (command === 'plugin:event|listen') {
          if (fixtureEventListenDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, fixtureEventListenDelayMs))
          }
          return nextEventId++
        }
        if (command === 'plugin:event|unlisten') return null
        if (command === 'plugin:window|is_fullscreen') return fullscreen
        if (command === 'plugin:window|set_fullscreen') {
          fullscreen = Boolean(args?.value)
          return null
        }
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:window|')) return null
        if (command.startsWith('plugin:webview|')) return null

        return null
      }
    },
    {
      fixtureBooks: books,
      fixtureEventListenDelayMs: eventListenDelayMs,
      fixtureExternallyOpenedBooks: externallyOpenedBooks,
      fixtureImportedBooks: importedBooks,
      fixtureEpubImportDelayMs: epubImportDelayMs,
      fixtureLocalDictionaries: localDictionaries,
      fixtureLocalDictionaryFiles: localDictionaryFiles,
      fixtureOpenDialogPaths: openDialogPaths,
      fixturePendingOpenPaths: pendingOpenPaths,
      fixturePendingOpenPathsError: pendingOpenPathsError,
      fixturePins: pins,
      fixtureDeferReaderSource: deferReaderSource,
      fixtureReaderSourceErrors: readerSourceErrors,
      fixtureReaderSources: readerSources,
      fixtureRevealableBookSourceIds: revealableBookSourceIds,
      fixtureSourceStatuses: sourceStatuses,
      fixtureSaveDialogPath: saveDialogPath,
      fixtureSettings: settings,
      fixtureTags: tags,
      fixtureTextImportEncodings: textImportEncodings,
      fixtureTextImportDelayMs: textImportDelayMs,
      fixtureTextImportPreviewDelayMs: textImportPreviewDelayMs,
      fixtureTextImportPreviews: textImportPreviews,
      fixtureMerriamWebsterResponses: merriamWebsterResponses,
      fixtureMdictResponses: mdictResponses,
      fixtureMdictStylesheets: mdictStylesheets,
      fixtureStardictResponses: stardictResponses,
      fixtureZdicResponses: zdicResponses,
      fixtureZdicResponseSequences: zdicResponseSequences,
      fixtureZdicResponseStatuses: zdicResponseStatuses,
      fixtureZdicResponseDelayMs: zdicResponseDelayMs,
      fixtureTranslationResponseDelayMs: translationResponseDelayMs,
      fixtureTranslationError: translationError,
      fixtureWindowUiState: testWindowUiState,
    },
  )
}

export async function getLocalDictionaryMockState(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __FLOW_TEST_TAURI__?: {
          dialogOpenCalls: unknown[]
          localDictionaries: LocalDictionaryRecord[]
        }
      }
    ).__FLOW_TEST_TAURI__
    return {
      dialogOpenCalls: state?.dialogOpenCalls ?? [],
      localDictionaries: state?.localDictionaries ?? [],
    }
  })
}

export async function getStoredSettings(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        settingsStore: Record<string, unknown>
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.settingsStore ?? {}
  })
}

export async function getStoredLibraryPins(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        libraryPinsStore: TestLibraryPins
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.libraryPinsStore ?? { authors: [], tagIds: [] }
  })
}

export async function getFullscreenState(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        fullscreen: boolean
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.fullscreen ?? false
  })
}

export async function getExportedBooks(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        exports: Array<{
          format: string
          id: string
          outputPath: string
        }>
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.exports ?? []
  })
}

export async function getImportedTextSelections(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        textImports: TextImportSelection[]
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.textImports ?? []
  })
}

export async function getBookImportOperations(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        bookImportOperations: string[]
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations ?? []
  })
}

export async function getDictionaryMockState(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        cancelledDictionarySessions: number[]
        dictionaryRequests: Array<{ query: string; sessionId: number }>
        merriamWebsterRequests: Array<{ query: string; sessionId: number }>
        mdictRequests: Array<{
          dictionaryId: string
          query: string
          sessionId: number
        }>
        mdictStylesheetRequests: Array<{
          dictionaryId: string
          key: string
          sessionId: number
        }>
        stardictRequests: Array<{
          dictionaryId: string
          query: string
          sessionId: number
        }>
        openedExternalUrls: string[]
      }
    }

    return {
      cancelledDictionarySessions: globalWindow.__FLOW_TEST_TAURI__?.cancelledDictionarySessions ?? [],
      dictionaryRequests: globalWindow.__FLOW_TEST_TAURI__?.dictionaryRequests ?? [],
      merriamWebsterRequests: globalWindow.__FLOW_TEST_TAURI__?.merriamWebsterRequests ?? [],
      mdictRequests: globalWindow.__FLOW_TEST_TAURI__?.mdictRequests ?? [],
      mdictStylesheetRequests: globalWindow.__FLOW_TEST_TAURI__?.mdictStylesheetRequests ?? [],
      stardictRequests: globalWindow.__FLOW_TEST_TAURI__?.stardictRequests ?? [],
      openedExternalUrls: globalWindow.__FLOW_TEST_TAURI__?.openedExternalUrls ?? [],
    }
  })
}
