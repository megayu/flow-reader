import type { Page } from '@playwright/test'

import type {
  BookRecord,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportSelection,
} from '../src/db'

export interface TestLibraryTagRecord {
  id: string
  name: string
  createdAt: number
  updatedAt?: number
}

interface TauriMockOptions {
  books?: BookRecord[]
  externallyOpenedBooks?: BookRecord[]
  importedBooks?: BookRecord[]
  openDialogPaths?: string[]
  pendingOpenPaths?: string[]
  deferReaderSource?: boolean
  readerSources?: Record<string, string>
  saveDialogPath?: string | null
  settings?: Record<string, unknown>
  tags?: TestLibraryTagRecord[]
  textImportEncodings?: TextImportEncodingOption[]
  textImportPreviews?: TextImportPreview[]
  zdicResponses?: Record<string, string>
  zdicResponseDelayMs?: number
}

export async function installTauriMock(
  page: Page,
  {
    books = [],
    externallyOpenedBooks = [],
    importedBooks = [],
    openDialogPaths = [],
    pendingOpenPaths = [],
    deferReaderSource = false,
    readerSources = {},
    saveDialogPath = null,
    settings = {},
    tags = [],
    textImportEncodings = [
      { id: 'auto', label: 'Auto' },
      { id: 'utf-8', label: 'UTF-8' },
      { id: 'gb18030', label: 'GB18030' },
    ],
    textImportPreviews = [],
    zdicResponses = {},
    zdicResponseDelayMs = 0,
  }: TauriMockOptions = {},
) {
  await page.addInitScript(
    ({
      fixtureBooks,
      fixtureExternallyOpenedBooks,
      fixtureImportedBooks,
      fixtureOpenDialogPaths,
      fixturePendingOpenPaths,
      fixtureDeferReaderSource,
      fixtureReaderSources,
      fixtureSaveDialogPath,
      fixtureSettings,
      fixtureTags,
      fixtureTextImportEncodings,
      fixtureTextImportPreviews,
      fixtureZdicResponses,
      fixtureZdicResponseDelayMs,
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
        transformCallback?: (
          callback: (...args: unknown[]) => unknown,
        ) => number
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
          openedExternalUrls: string[]
          takePendingOpenPathsCalls: number
          settingsStore: Record<string, unknown>
          textImports: TextImportSelection[]
        }
        __TAURI_INTERNALS__?: TauriInternals
      }
      const settingsStorageKey = '__FLOW_TEST_TAURI_SETTINGS__'
      const storedSettings = (() => {
        try {
          return JSON.parse(
            localStorage.getItem(settingsStorageKey) ?? '{}',
          ) as Record<string, unknown> | undefined
        } catch {
          return undefined
        }
      })()
      const bookStore = new Map<string, BookRecord>(
        fixtureBooks.map((book) => [book.id, book]),
      )
      const tagStore = new Map<string, TestLibraryTagRecord>(
        fixtureTags.map((tag) => [tag.id, tag]),
      )
      const importQueue = [...fixtureImportedBooks]
      const externalOpenQueue = [...fixtureExternallyOpenedBooks]
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
      const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??=
        {})
      const callbacks = (internals.callbacks ??= {})

      globalWindow.__FLOW_TEST_TAURI__ = {
        cancelledDictionarySessions: [],
        dictionaryRequests: [],
        exports: [],
        get fullscreen() {
          return fullscreen
        },
        takePendingOpenPathsCalls: 0,
        settingsStore,
        openedExternalUrls: [],
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
        if (command === 'fetch_zdic') {
          const query = String(args?.query ?? '')
          const sessionId = Number(args?.sessionId ?? 0)
          globalWindow.__FLOW_TEST_TAURI__?.dictionaryRequests.push({
            query,
            sessionId,
          })
          if (fixtureZdicResponseDelayMs > 0) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, fixtureZdicResponseDelayMs),
            )
          }
          return {
            body: fixtureZdicResponses[query] ?? '',
            finalUrl: `https://zdic.net/hans/${encodeURIComponent(query)}`,
            status: 200,
          }
        }
        if (command === 'cancel_dictionary_session') {
          globalWindow.__FLOW_TEST_TAURI__?.cancelledDictionarySessions.push(
            Number(args?.sessionId ?? 0),
          )
          return null
        }
        if (command === 'open_external_url') {
          globalWindow.__FLOW_TEST_TAURI__?.openedExternalUrls.push(
            String(args?.url ?? ''),
          )
          return null
        }
        if (command === 'get_settings') return { ...settingsStore }
        if (command === 'update_settings') {
          Object.assign(settingsStore, args?.settings ?? {})
          localStorage.setItem(
            settingsStorageKey,
            JSON.stringify(settingsStore),
          )
          return null
        }
        if (command === 'list_books') return Array.from(bookStore.values())
        if (command === 'list_tags') return Array.from(tagStore.values())
        if (command === 'create_tag') {
          const name = String(args?.name ?? '')
            .replace(/\s+/g, ' ')
            .trim()
          if (!name) return null
          const existing = Array.from(tagStore.values()).find(
            (tag) => tag.name.toLowerCase() === name.toLowerCase(),
          )
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
            (tag) =>
              tag.id !== id && tag.name.toLowerCase() === name.toLowerCase(),
          )
          if (duplicate) return current

          const updated = { ...current, name, updatedAt: Date.now() }
          tagStore.set(id, updated)
          return updated
        }
        if (command === 'delete_tag') {
          const id = String(args?.id)
          tagStore.delete(id)
          bookStore.forEach((book, bookId) => {
            const tagIds = (
              (book as BookRecord & { tagIds?: string[] }).tagIds ?? []
            ).filter((tagId) => tagId !== id)
            bookStore.set(bookId, { ...book, tagIds })
          })
          return Array.from(bookStore.values())
        }
        if (command === 'update_book_tags') {
          const ids = Array.isArray(args?.ids) ? args.ids.map(String) : []
          const addTagIds = Array.isArray(args?.addTagIds)
            ? args.addTagIds.map(String)
            : []
          const removeTagIds = Array.isArray(args?.removeTagIds)
            ? args.removeTagIds.map(String)
            : []
          const updatedBooks: BookRecord[] = []

          ids.forEach((id) => {
            const current = bookStore.get(id)
            if (!current) return

            const tagIds = new Set(
              (current as BookRecord & { tagIds?: string[] }).tagIds ?? [],
            )
            removeTagIds.forEach((tagId) => tagIds.delete(tagId))
            addTagIds.forEach((tagId) => tagIds.add(tagId))

            const updated = { ...current, tagIds: Array.from(tagIds) }
            bookStore.set(id, updated)
            updatedBooks.push(updated)
          })

          return updatedBooks
        }
        if (command === 'get_book')
          return bookStore.get(String(args?.id)) ?? null
        if (command === 'get_book_reader_source' && fixtureDeferReaderSource) {
          return new Promise(() => undefined)
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
          return updated
        }
        if (command === 'delete_books') {
          const ids = Array.isArray(args?.ids) ? args.ids : []
          ids.forEach((id) => bookStore.delete(String(id)))
          return null
        }
        if (command === 'import_epub_paths') {
          const paths = Array.isArray(args?.paths) ? args.paths : []
          const imported = importQueue.splice(0, Math.max(paths.length, 1))
          imported.forEach((book) => bookStore.set(book.id, book))
          return {
            books: imported,
            failures: [],
          }
        }
        if (command === 'open_external_epub_paths') {
          const paths = Array.isArray(args?.paths) ? args.paths : []
          const opened = externalOpenQueue.splice(0, Math.max(paths.length, 1))
          opened.forEach((book) => bookStore.set(book.id, book))
          return { books: opened, failures: [] }
        }
        if (command === 'get_text_import_encodings') {
          return fixtureTextImportEncodings
        }
        if (command === 'preview_text_import_paths') {
          const paths = Array.isArray(args?.paths) ? args.paths.map(String) : []
          return paths.map((path) => {
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
        }
        if (command === 'import_text_paths') {
          const imports = Array.isArray(args?.imports)
            ? (args.imports as TextImportSelection[])
            : []
          globalWindow.__FLOW_TEST_TAURI__?.textImports.push(...imports)
          const imported = importQueue.splice(0, Math.max(imports.length, 1))
          imported.forEach((book) => bookStore.set(book.id, book))
          return imported
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
            exportedVersions: {
              ...(current.exportedVersions ?? {}),
              [format]: current.contentVersion ?? 0,
            },
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
          return fixturePendingOpenPaths
        }
        if (command === 'plugin:dialog|open') return fixtureOpenDialogPaths
        if (command === 'plugin:dialog|save') return fixtureSaveDialogPath
        if (command === 'flush_storage') return null
        if (command === 'plugin:event|listen') return nextEventId++
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
      fixtureExternallyOpenedBooks: externallyOpenedBooks,
      fixtureImportedBooks: importedBooks,
      fixtureOpenDialogPaths: openDialogPaths,
      fixturePendingOpenPaths: pendingOpenPaths,
      fixtureDeferReaderSource: deferReaderSource,
      fixtureReaderSources: readerSources,
      fixtureSaveDialogPath: saveDialogPath,
      fixtureSettings: settings,
      fixtureTags: tags,
      fixtureTextImportEncodings: textImportEncodings,
      fixtureTextImportPreviews: textImportPreviews,
      fixtureZdicResponses: zdicResponses,
      fixtureZdicResponseDelayMs: zdicResponseDelayMs,
    },
  )
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

export async function getDictionaryMockState(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        cancelledDictionarySessions: number[]
        dictionaryRequests: Array<{ query: string; sessionId: number }>
        openedExternalUrls: string[]
      }
    }

    return {
      cancelledDictionarySessions:
        globalWindow.__FLOW_TEST_TAURI__?.cancelledDictionarySessions ?? [],
      dictionaryRequests:
        globalWindow.__FLOW_TEST_TAURI__?.dictionaryRequests ?? [],
      openedExternalUrls:
        globalWindow.__FLOW_TEST_TAURI__?.openedExternalUrls ?? [],
    }
  })
}
