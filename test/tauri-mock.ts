import type { Page } from '@playwright/test'

import type { BookRecord } from '../src/db'

interface TauriMockOptions {
  books?: BookRecord[]
  importedBooks?: BookRecord[]
  openDialogPaths?: string[]
  settings?: Record<string, unknown>
}

export async function installTauriMock(
  page: Page,
  {
    books = [],
    importedBooks = [],
    openDialogPaths = [],
    settings = {},
  }: TauriMockOptions = {},
) {
  await page.addInitScript(
    ({
      fixtureBooks,
      fixtureImportedBooks,
      fixtureOpenDialogPaths,
      fixtureSettings,
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
          settingsStore: Record<string, unknown>
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
      const importQueue = [...fixtureImportedBooks]
      const settingsStore: Record<string, unknown> = {
        locale: 'en-US',
        ...(storedSettings ?? {}),
        ...fixtureSettings,
      }
      let nextCallbackId = 1
      let nextEventId = 1

      const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
      const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??=
        {})
      const callbacks = (internals.callbacks ??= {})

      globalWindow.__FLOW_TEST_TAURI__ = { settingsStore }
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
        if (command === 'get_book')
          return bookStore.get(String(args?.id)) ?? null
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
          return imported
        }
        if (command === 'list_covers') return []
        if (command === 'get_cover') return null
        if (command === 'take_pending_open_paths') return []
        if (command === 'plugin:dialog|open') return fixtureOpenDialogPaths
        if (command === 'flush_storage') return null
        if (command === 'plugin:event|listen') return nextEventId++
        if (command === 'plugin:event|unlisten') return null
        if (command.startsWith('plugin:window|is_')) return false
        if (command.startsWith('plugin:window|')) return null
        if (command.startsWith('plugin:webview|')) return null

        return null
      }
    },
    {
      fixtureBooks: books,
      fixtureImportedBooks: importedBooks,
      fixtureOpenDialogPaths: openDialogPaths,
      fixtureSettings: settings,
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
