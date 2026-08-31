import type { Page } from '@playwright/test'

import type { LocalDictionaryRecord } from '../../src/dictionary/native'
import type { TextImportRulesConfiguration } from '../../src/settings/configuration'
import type { WindowUiState } from '../../src/state'
import type {
  BookImageIndexCache,
  BookModeSwitchConflict,
  BookModeSwitchResolution,
  BookRecord,
  BookSearchResult,
  BookSourceStatus,
  FolderImportCandidate,
  FolderImportTagAssignment,
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
  bookSearchResults?: Record<string, BookSearchResult[]>
  books?: BookRecord[]
  contentModeSwitchConflicts?: Record<string, BookModeSwitchConflict>
  contentModeSwitchErrors?: Record<string, string>
  eventListenDelayMs?: number
  externallyOpenedBooks?: BookRecord[]
  importedBooks?: BookRecord[]
  imageIndexes?: Record<string, BookImageIndexCache>
  epubImportDelayMs?: number
  folderDialogPaths?: string[]
  folderImportCandidates?: Record<string, FolderImportCandidate[]>
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
  textImportRuleDefaults?: TextImportRulesConfiguration
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
    bookSearchResults = {},
    books = [],
    contentModeSwitchConflicts = {},
    contentModeSwitchErrors = {},
    eventListenDelayMs = 0,
    externallyOpenedBooks = [],
    importedBooks = [],
    imageIndexes = {},
    epubImportDelayMs = 0,
    folderDialogPaths = [],
    folderImportCandidates = {},
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
    textImportRuleDefaults = {
      groupPatterns: ['^default-group$'],
      chapterPatterns: ['^default-chapter$'],
      filenamePatterns: ['default-$title'],
    },
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
      fixtureBookSearchResults,
      fixtureBooks,
      fixtureContentModeSwitchConflicts,
      fixtureContentModeSwitchErrors,
      fixtureEventListenDelayMs,
      fixtureExternallyOpenedBooks,
      fixtureImportedBooks,
      fixtureImageIndexes,
      fixtureEpubImportDelayMs,
      fixtureFolderDialogPaths,
      fixtureFolderImportCandidates,
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
      fixtureTextImportRuleDefaults,
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
          contentModeSwitchOperations: Array<{
            editable: boolean
            id: string
            resolution?: BookModeSwitchResolution
          }>
          libraryPinsStore: TestLibraryPins
          books: BookRecord[]
          tags: TestLibraryTagRecord[]
          bookImportOperations: string[]
          openedExternalUrls: string[]
          openedBookDirectoryIds: string[]
          revealedBookSourceIds: string[]
          takePendingOpenPathsCalls: number
          settingsOperations: string[]
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
      const normalizeName = (value: unknown) =>
        String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
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
            .map((book) => normalizeName(book.metadata.creator))
            .filter(Boolean),
        )
        libraryPinsStore.authors = libraryPinsStore.authors.filter((author) => authors.has(author))
        persistLibraryPins()
      }
      const importQueue = [...fixtureImportedBooks]
      const externalOpenQueue = [...fixtureExternallyOpenedBooks]
      const folderDialogQueue = [...fixtureFolderDialogPaths]
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
      globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
        unregisterListener: () => undefined,
      }
      const callbacks = (internals.callbacks ??= {})
      const streamChannelMessages = (channel: unknown, messages: unknown[]) => {
        if (!channel || typeof channel !== 'object' || !('id' in channel)) return false

        const callback = callbacks[Number(channel.id)]
        if (!callback) return false

        messages.forEach((message, index) => callback({ index, message }))
        callback({ end: true, index: messages.length })
        return true
      }

      globalWindow.__FLOW_TEST_TAURI__ = {
        bookImportOperations: [],
        contentModeSwitchOperations: [],
        cancelledDictionarySessions: [],
        dictionaryRequests: [],
        dialogOpenCalls: [],
        merriamWebsterRequests: [],
        mdictRequests: [],
        mdictStylesheetRequests: [],
        stardictRequests: [],
        localDictionaries: localDictionaryStore,
        libraryPinsStore,
        get books() {
          return Array.from(bookStore.values())
        },
        get tags() {
          return Array.from(tagStore.values())
        },
        exports: [],
        get fullscreen() {
          return fullscreen
        },
        takePendingOpenPathsCalls: 0,
        settingsOperations: [],
        settingsStore,
        openedExternalUrls: [],
        openedBookDirectoryIds: [],
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
        if (command === 'get_settings') {
          return {
            settings: { ...settingsStore },
            textImportRuleDefaults: fixtureTextImportRuleDefaults,
          }
        }
        if (command === 'update_settings') {
          globalWindow.__FLOW_TEST_TAURI__?.settingsOperations.push('update')
          const settings = args?.settings
          if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
            for (const key of Object.keys(settingsStore)) delete settingsStore[key]
            Object.assign(settingsStore, settings)
          }
          if (args?.flush === true) {
            localStorage.setItem(settingsStorageKey, JSON.stringify(settingsStore))
          }
          return null
        }
        if (command === 'reset_text_import_rule') {
          const kind = String(args?.kind ?? '') as keyof TextImportRulesConfiguration
          globalWindow.__FLOW_TEST_TAURI__?.settingsOperations.push(`reset:${kind}`)
          const rules = (settingsStore.textImportRules ?? {}) as Partial<TextImportRulesConfiguration>
          settingsStore.textImportRules = {
            ...rules,
            [kind]: [...fixtureTextImportRuleDefaults[kind]],
          }
          return null
        }
        if (command === 'flush_settings') {
          globalWindow.__FLOW_TEST_TAURI__?.settingsOperations.push('flush')
          localStorage.setItem(settingsStorageKey, JSON.stringify(settingsStore))
          return null
        }
        if (command === 'list_books') return Array.from(bookStore.values())
        if (command === 'scan_import_folder') {
          return fixtureFolderImportCandidates[String(args?.root ?? '')] ?? []
        }
        if (command === 'apply_folder_import_tags') {
          const assignments = Array.isArray(args?.assignments) ? (args.assignments as FolderImportTagAssignment[]) : []
          const updatedBooks: BookRecord[] = []
          assignments.forEach((assignment) => {
            const current = bookStore.get(assignment.bookId)
            if (!current) return

            const tagIds = new Set(current.tagIds ?? [])
            const seenNames = new Set<string>()
            assignment.tagNames.forEach((rawName) => {
              const name = normalizeName(rawName)
              const normalizedName = name.toLowerCase()
              if (!name || seenNames.has(normalizedName)) return
              seenNames.add(normalizedName)

              let tag = Array.from(tagStore.values()).find(
                (candidate) => candidate.name.toLowerCase() === normalizedName,
              )
              if (!tag) {
                tag = {
                  id: `tag-folder-${tagStore.size + 1}`,
                  name,
                  createdAt: Date.now(),
                }
                tagStore.set(tag.id, tag)
              }
              tagIds.add(tag.id)
            })

            const updated = { ...current, tagIds: Array.from(tagIds) }
            bookStore.set(updated.id, updated)
            updatedBooks.push(updated)
          })
          return { books: updatedBooks, tags: Array.from(tagStore.values()) }
        }
        if (command === 'list_tags') return Array.from(tagStore.values())
        if (command === 'get_library_pins') return structuredClone(libraryPinsStore)
        if (command === 'update_library_pin') {
          const kind = String(args?.kind ?? '')
          const id = normalizeName(args?.id)
          const pinned = Boolean(args?.pinned)
          const items = kind === 'author' ? libraryPinsStore.authors : libraryPinsStore.tagIds
          const exists =
            kind === 'author'
              ? Array.from(bookStore.values()).some((book) => normalizeName(book.metadata.creator) === id)
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
          const name = normalizeName(args?.name)
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
          const name = normalizeName(args?.name ?? current.name)
          if (!name) return current

          const duplicate = Array.from(tagStore.values()).find(
            (tag) => tag.id !== id && tag.name.toLowerCase() === name.toLowerCase(),
          )
          if (duplicate) return current

          const updated = { ...current, name, updatedAt: Date.now() }
          tagStore.set(id, updated)
          return updated
        }
        if (command === 'delete_tags') {
          const ids = new Set(Array.isArray(args?.ids) ? args.ids.map(String) : [])
          ids.forEach((id) => tagStore.delete(id))
          libraryPinsStore.tagIds = libraryPinsStore.tagIds.filter((tagId) => !ids.has(tagId))
          persistLibraryPins()
          bookStore.forEach((book, bookId) => {
            const tagIds = ((book as BookRecord & { tagIds?: string[] }).tagIds ?? []).filter(
              (tagId) => !ids.has(tagId),
            )
            bookStore.set(bookId, { ...book, tagIds })
          })
          return null
        }
        if (command === 'merge_tags') {
          const ids = new Set(Array.isArray(args?.ids) ? args.ids.map(String) : [])
          if (ids.size < 2 || [...ids].some((id) => !tagStore.has(id))) throw new Error('Invalid merge selection')
          const targetId = args?.targetId ? String(args.targetId) : undefined
          const targetName = normalizeName(args?.targetName)
          if (targetId && !ids.has(targetId)) throw new Error('Merge target must be selected')
          let target = targetId ? tagStore.get(targetId) : undefined
          if (!target && targetName) {
            const existing = Array.from(tagStore.values()).find(
              (tag) => normalizeName(tag.name).toLowerCase() === targetName.toLowerCase(),
            )
            if (existing && !ids.has(existing.id)) throw new Error('Merge target name already exists')
            target = existing ?? {
              id: `tag-${targetName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
              name: targetName,
              createdAt: Date.now(),
            }
            if (!existing) {
              tagStore.set(target.id, target)
            }
          }
          if (!target) throw new Error('Merge target is required')

          ids.forEach((id) => {
            if (id !== target?.id) tagStore.delete(id)
          })
          const pinned = libraryPinsStore.tagIds.some((tagId) => ids.has(tagId))
          libraryPinsStore.tagIds = libraryPinsStore.tagIds.filter((tagId) => !ids.has(tagId))
          if (pinned) libraryPinsStore.tagIds.unshift(target.id)
          persistLibraryPins()
          bookStore.forEach((book, bookId) => {
            const currentTagIds = (book as BookRecord & { tagIds?: string[] }).tagIds ?? []
            if (!currentTagIds.some((tagId) => ids.has(tagId))) return
            bookStore.set(bookId, {
              ...book,
              tagIds: [...currentTagIds.filter((tagId) => !ids.has(tagId)), target.id],
            })
          })
          return target
        }
        if (command === 'update_book_tags') {
          const ids = Array.isArray(args?.ids) ? args.ids.map(String) : []
          const addTagIds = Array.isArray(args?.addTagIds) ? args.addTagIds.map(String) : []
          const removeTagIds = Array.isArray(args?.removeTagIds) ? args.removeTagIds.map(String) : []
          ids.forEach((id) => {
            const current = bookStore.get(id)
            if (!current) return

            const tagIds = new Set((current as BookRecord & { tagIds?: string[] }).tagIds ?? [])
            removeTagIds.forEach((tagId) => tagIds.delete(tagId))
            addTagIds.forEach((tagId) => tagIds.add(tagId))

            const updated = { ...current, tagIds: Array.from(tagIds) }
            bookStore.set(id, updated)
          })

          return null
        }
        if (command === 'get_book') return bookStore.get(String(args?.id)) ?? null
        if (command === 'search_book_text') {
          return fixtureBookSearchResults[String(args?.keyword ?? '')] ?? []
        }
        if (command === 'load_book_image_index') {
          return fixtureImageIndexes[String(args?.id)] ?? null
        }
        if (command === 'reveal_book_source') {
          const id = String(args?.id)
          if (!fixtureRevealableBookSourceIds.includes(id)) return false
          globalWindow.__FLOW_TEST_TAURI__?.revealedBookSourceIds.push(id)
          return true
        }
        if (command === 'open_book_directory') {
          globalWindow.__FLOW_TEST_TAURI__?.openedBookDirectoryIds.push(String(args?.id))
          return null
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
          if (message) {
            if (message === 'BOOK_SOURCE_MISSING') fixtureSourceStatuses[id] = 'missing'
            if (message === 'BOOK_SOURCE_UNREADABLE') fixtureSourceStatuses[id] = 'unreadable'
            throw new Error(message)
          }
        }
        if (command === 'get_book_reader_source') {
          const path = fixtureReaderSources[String(args?.id)] ?? ''
          if (!path) return null
          const opfRootEnd = path.lastIndexOf('/OPS/')
          return {
            mode: path.toLowerCase().endsWith('.epub') ? 'epub' : 'opf',
            path,
            rootPath: opfRootEnd < 0 ? undefined : path.slice(0, opfRootEnd + 1),
          }
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
          return null
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
          const streamed = streamChannelMessages(
            args?.onProgress,
            imported.map((book, index) => ({
              book,
              completed: index + 1,
              failed: 0,
              imported: index + 1,
              skipped: 0,
              total: paths.length,
            })),
          )
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('epub:finish')
          return {
            books: streamed ? [] : imported,
            failures: [],
            skipped: [],
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
          return { books: opened, failures: [], skipped: [] }
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
          const streamed = streamChannelMessages(
            args?.onProgress,
            imported.map((book, index) => ({
              book,
              completed: index + 1,
              failed: 0,
              imported: index + 1,
              skipped: 0,
              total: imports.length,
            })),
          )
          globalWindow.__FLOW_TEST_TAURI__?.bookImportOperations.push('txt-import:finish')
          return { books: streamed ? [] : imported, failures: [], skipped: [] }
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
            latestExportRevision: Math.max(current.sourceRevision, current.revision),
          }
          bookStore.set(id, updated)
          return updated
        }
        if (command === 'check_book_content_mode_switch') {
          return fixtureContentModeSwitchConflicts[String(args?.id)] ?? null
        }
        if (command === 'switch_book_content_mode') {
          const id = String(args?.id)
          const current = bookStore.get(id)
          if (!current) throw new Error('Book not found')
          const editable = Boolean(args?.editable)
          const resolution = args?.resolution as BookModeSwitchResolution | undefined
          globalWindow.__FLOW_TEST_TAURI__?.contentModeSwitchOperations.push({ editable, id, resolution })
          const error = fixtureContentModeSwitchErrors[id]
          if (error) throw new Error(error)
          const conflict = fixtureContentModeSwitchConflicts[id]
          if (conflict && !resolution) return { conflict }

          const updated = { ...current, editable, updatedAt: Date.now() }
          bookStore.set(id, updated)
          return { book: updated }
        }
        if (command === 'list_covers') return []
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
          const options = args?.options as { directory?: boolean; multiple?: boolean } | undefined
          if (options?.directory) return folderDialogQueue.shift() ?? null
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
      fixtureBookSearchResults: bookSearchResults,
      fixtureBooks: books,
      fixtureContentModeSwitchConflicts: contentModeSwitchConflicts,
      fixtureContentModeSwitchErrors: contentModeSwitchErrors,
      fixtureEventListenDelayMs: eventListenDelayMs,
      fixtureExternallyOpenedBooks: externallyOpenedBooks,
      fixtureImportedBooks: importedBooks,
      fixtureImageIndexes: imageIndexes,
      fixtureEpubImportDelayMs: epubImportDelayMs,
      fixtureFolderDialogPaths: folderDialogPaths,
      fixtureFolderImportCandidates: folderImportCandidates,
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
      fixtureTextImportRuleDefaults: textImportRuleDefaults,
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

export async function getSettingsOperations(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        settingsOperations: string[]
      }
    }

    return [...(globalWindow.__FLOW_TEST_TAURI__?.settingsOperations ?? [])]
  })
}

export async function clearSettingsOperations(page: Page) {
  await page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        settingsOperations: string[]
      }
    }

    if (globalWindow.__FLOW_TEST_TAURI__) globalWindow.__FLOW_TEST_TAURI__.settingsOperations.length = 0
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

export async function getStoredLibraryMockState(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        books: BookRecord[]
        tags: TestLibraryTagRecord[]
      }
    }

    return {
      books: globalWindow.__FLOW_TEST_TAURI__?.books ?? [],
      tags: globalWindow.__FLOW_TEST_TAURI__?.tags ?? [],
    }
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
