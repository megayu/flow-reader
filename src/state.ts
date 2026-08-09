import { useEffect } from 'react'
import { create } from 'zustand'

import { IS_SERVER } from '@/env'
import { isAppLocale, resolveSystemLocale } from '@/locales'
import { normalizeThemeConfiguration } from '@/styles/theme'
import { normalizeUiFontSize } from '@/styles/ui'

import {
  type DictionarySettingsConfiguration,
  defaultDictionarySettings,
  defaultLibraryBookCardWidth,
  defaultLibrarySort,
  defaultSettings,
  defaultTranslationSettings,
  type LibraryDisplayConfiguration,
  type LibrarySortConfiguration,
  type LibrarySortField,
  libraryBookCardWidthMax,
  libraryBookCardWidthMin,
  libraryBookCardWidthStep,
  librarySortFieldOptions,
  normalizeTextImportRules,
  type Settings,
  type TranslationSettingsConfiguration,
  type TypographyConfiguration,
  type ViewMode,
} from './settings/configuration'
import { getSettingsFromStorage, type ReadingStatus, updateSettingsInStorage } from './storage'
import { TRANSLATION_LANGUAGES } from './translation/languages'

export * from './settings/configuration'

export type SetterOrUpdater<T> = (value: T | ((prev: T) => T)) => void

export type Action = 'toc' | 'search' | 'annotation' | 'typography' | 'image'
export type LibraryAction = 'libraryFilter'

export interface WindowPaneState {
  expanded: boolean
  size?: number
}

export interface WindowUiState {
  librarySidebarOpen: boolean
  librarySidebarWidth: number
  panes: Record<string, WindowPaneState>
  readerSidebarOpen: boolean
  readerSidebarWidth: number
}

interface AppStore {
  action?: Action
  bookCacheClearing: boolean
  libraryAction?: LibraryAction
  libraryAuthorFilter: string[]
  libraryAuthorFilterExpanded: boolean
  libraryStatusFilter: ReadingStatus[]
  libraryTagFilter: string[]
  libraryTagFilterExpanded: boolean
  librarySidebarWidth?: number
  panes?: Record<string, WindowPaneState>
  readerSidebarWidth?: number
  settings: Settings
  settingsDialogOpen: boolean
  settingsReady: boolean
  viewMode: ViewMode
  zenMode: boolean
  zenTypographyOverrides: Record<string, TypographyConfiguration>
  setAction: SetterOrUpdater<Action | undefined>
  setBookCacheClearing: SetterOrUpdater<boolean>
  setLibraryAction: SetterOrUpdater<LibraryAction | undefined>
  setLibraryAuthorFilter: SetterOrUpdater<string[]>
  setLibraryAuthorFilterExpanded: SetterOrUpdater<boolean>
  setLibraryStatusFilter: SetterOrUpdater<ReadingStatus[]>
  setLibraryTagFilter: SetterOrUpdater<string[]>
  setLibraryTagFilterExpanded: SetterOrUpdater<boolean>
  setLibrarySidebarWidth(value: number): void
  setPaneState(key: string, value: WindowPaneState | ((prev: WindowPaneState | undefined) => WindowPaneState)): void
  setReaderSidebarWidth(value: number): void
  setSettings: SetterOrUpdater<Settings>
  setSettingsDialogOpen: SetterOrUpdater<boolean>
  setSettingsReady: SetterOrUpdater<boolean>
  setViewMode: SetterOrUpdater<ViewMode>
  setZenMode: SetterOrUpdater<boolean>
  setZenTypographyOverrides: SetterOrUpdater<Record<string, TypographyConfiguration>>
}

function resolveUpdate<T>(value: T | ((prev: T) => T), prev: T) {
  return typeof value === 'function' ? (value as (prev: T) => T)(prev) : value
}

export const useAppStore = create<AppStore>((set) => ({
  action: undefined,
  bookCacheClearing: false,
  libraryAction: undefined,
  libraryAuthorFilter: [],
  libraryAuthorFilterExpanded: true,
  libraryStatusFilter: [],
  libraryTagFilter: [],
  libraryTagFilterExpanded: true,
  librarySidebarWidth: undefined,
  panes: undefined,
  readerSidebarWidth: undefined,
  settings: defaultSettings,
  settingsDialogOpen: false,
  settingsReady: false,
  viewMode: 'library',
  zenMode: false,
  zenTypographyOverrides: {},
  setAction: (value) => set((state) => ({ action: resolveUpdate(value, state.action) })),
  setBookCacheClearing: (value) =>
    set((state) => ({ bookCacheClearing: resolveUpdate(value, state.bookCacheClearing) })),
  setLibraryAction: (value) =>
    set((state) => ({
      libraryAction: resolveUpdate(value, state.libraryAction),
    })),
  setLibraryAuthorFilter: (value) =>
    set((state) => ({
      libraryAuthorFilter: resolveUpdate(value, state.libraryAuthorFilter),
    })),
  setLibraryAuthorFilterExpanded: (value) =>
    set((state) => ({
      libraryAuthorFilterExpanded: resolveUpdate(value, state.libraryAuthorFilterExpanded),
    })),
  setLibraryStatusFilter: (value) =>
    set((state) => ({
      libraryStatusFilter: resolveUpdate(value, state.libraryStatusFilter),
    })),
  setLibraryTagFilter: (value) =>
    set((state) => ({
      libraryTagFilter: resolveUpdate(value, state.libraryTagFilter),
    })),
  setLibraryTagFilterExpanded: (value) =>
    set((state) => ({
      libraryTagFilterExpanded: resolveUpdate(value, state.libraryTagFilterExpanded),
    })),
  setLibrarySidebarWidth: (value) => set({ librarySidebarWidth: value }),
  setPaneState: (key, value) =>
    set((state) => {
      const panes = state.panes!
      const next = typeof value === 'function' ? value(panes[key]) : value
      return { panes: { ...panes, [key]: next } }
    }),
  setReaderSidebarWidth: (value) => set({ readerSidebarWidth: value }),
  setSettings: (value) => set((state) => ({ settings: resolveUpdate(value, state.settings) })),
  setSettingsDialogOpen: (value) =>
    set((state) => ({
      settingsDialogOpen: resolveUpdate(value, state.settingsDialogOpen),
    })),
  setSettingsReady: (value) =>
    set((state) => ({
      settingsReady: resolveUpdate(value, state.settingsReady),
    })),
  setViewMode: (value) => set((state) => ({ viewMode: resolveUpdate(value, state.viewMode) })),
  setZenMode: (value) => set((state) => ({ zenMode: resolveUpdate(value, state.zenMode) })),
  setZenTypographyOverrides: (value) =>
    set((state) => ({
      zenTypographyOverrides: resolveUpdate(value, state.zenTypographyOverrides),
    })),
}))

export function initializeWindowUiState(value: WindowUiState) {
  useAppStore.setState({
    action: value.readerSidebarOpen ? 'toc' : undefined,
    libraryAction: value.librarySidebarOpen ? 'libraryFilter' : undefined,
    librarySidebarWidth: value.librarySidebarWidth,
    panes: value.panes,
    readerSidebarWidth: value.readerSidebarWidth,
  })
}

export function snapshotWindowUiState(): WindowUiState {
  const state = useAppStore.getState()
  return {
    librarySidebarOpen: state.libraryAction !== undefined,
    librarySidebarWidth: state.librarySidebarWidth!,
    panes: state.panes!,
    readerSidebarOpen: state.action !== undefined,
    readerSidebarWidth: state.readerSidebarWidth!,
  }
}

export function useSidebarWidth(viewMode: ViewMode) {
  const width = useAppStore((state) => (viewMode === 'library' ? state.librarySidebarWidth : state.readerSidebarWidth))
  const setWidth = useAppStore((state) =>
    viewMode === 'library' ? state.setLibrarySidebarWidth : state.setReaderSidebarWidth,
  )

  return [width!, setWidth] as const
}

export function useReaderActionState() {
  const action = useAppStore((state) => state.action)
  const setAction = useAppStore((state) => state.setAction)

  return [action, setAction] as const
}

export function useSetReaderActionState() {
  return useAppStore((state) => state.setAction)
}

export function useLibraryActionState() {
  const action = useAppStore((state) => state.libraryAction)
  const setAction = useAppStore((state) => state.setLibraryAction)

  return [action, setAction] as const
}

export function useLibraryStatusFilter() {
  const filters = useAppStore((state) => state.libraryStatusFilter)
  const setFilters = useAppStore((state) => state.setLibraryStatusFilter)

  return [filters, setFilters] as const
}

export function useLibraryAuthorFilter() {
  const filters = useAppStore((state) => state.libraryAuthorFilter)
  const setFilters = useAppStore((state) => state.setLibraryAuthorFilter)

  return [filters, setFilters] as const
}

export function useLibraryAuthorFilterExpanded() {
  const expanded = useAppStore((state) => state.libraryAuthorFilterExpanded)
  const setExpanded = useAppStore((state) => state.setLibraryAuthorFilterExpanded)

  return [expanded, setExpanded] as const
}

export function useLibraryTagFilter() {
  const filters = useAppStore((state) => state.libraryTagFilter)
  const setFilters = useAppStore((state) => state.setLibraryTagFilter)

  return [filters, setFilters] as const
}

export function useLibraryTagFilterExpanded() {
  const expanded = useAppStore((state) => state.libraryTagFilterExpanded)
  const setExpanded = useAppStore((state) => state.setLibraryTagFilterExpanded)

  return [expanded, setExpanded] as const
}

export function useSettingsDialogOpen() {
  const open = useAppStore((state) => state.settingsDialogOpen)
  const setOpen = useAppStore((state) => state.setSettingsDialogOpen)

  return [open, setOpen] as const
}

export function useBookCacheClearing() {
  return useAppStore((state) => state.bookCacheClearing)
}

export function useSetBookCacheClearing() {
  return useAppStore((state) => state.setBookCacheClearing)
}

export function waitForBookCacheClearing() {
  if (!useAppStore.getState().bookCacheClearing) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const unlisten = useAppStore.subscribe((state) => {
      if (state.bookCacheClearing) return
      unlisten()
      resolve()
    })
    if (!useAppStore.getState().bookCacheClearing) {
      unlisten()
      resolve()
    }
  })
}

export function useSetSettingsDialogOpen() {
  return useAppStore((state) => state.setSettingsDialogOpen)
}

export function useUiFontSizeValue() {
  return useAppStore((state) => normalizeUiFontSize(state.settings.ui?.fontSize))
}

export function useViewMode() {
  const viewMode = useAppStore((state) => state.viewMode)
  const setViewMode = useAppStore((state) => state.setViewMode)

  return [viewMode, setViewMode] as const
}

export function useViewModeValue() {
  return useAppStore((state) => state.viewMode)
}

export function useSetViewMode() {
  return useAppStore((state) => state.setViewMode)
}

export function useZenMode() {
  const zenMode = useAppStore((state) => state.zenMode)
  const setZenMode = useAppStore((state) => state.setZenMode)

  return [zenMode, setZenMode] as const
}

export function useZenModeValue() {
  return useAppStore((state) => state.zenMode)
}

export function useSetZenMode() {
  return useAppStore((state) => state.setZenMode)
}

export function useZenTypographyOverrides() {
  return useAppStore((state) => state.zenTypographyOverrides)
}

export function useSetZenTypographyOverrides() {
  return useAppStore((state) => state.setZenTypographyOverrides)
}

let settingsLoaded = false
let settingsLoadPromise: Promise<Settings> | undefined

function loadSettings() {
  settingsLoadPromise ??= getSettingsFromStorage<Partial<Settings>>()
    .then((value) => normalizeSettings(initializeSettingsLocale(value)))
    .catch(() => normalizeSettings(initializeSettingsLocale(undefined)))

  return settingsLoadPromise
}

function initializeSettingsLocale(value: Partial<Settings> | undefined): Partial<Settings> {
  if (isAppLocale(value?.locale)) return value

  const languages =
    typeof navigator === 'undefined'
      ? []
      : [navigator.language, ...(Array.isArray(navigator.languages) ? navigator.languages : [])]

  return {
    ...value,
    locale: resolveSystemLocale(languages),
  }
}

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  const settings = { ...defaultSettings, ...value }

  return {
    ...settings,
    theme: normalizeThemeConfiguration(settings.theme),
    libraryDisplay: normalizeLibraryDisplay(settings.libraryDisplay),
    librarySort: normalizeLibrarySort(settings.librarySort),
    textImportRules: normalizeTextImportRules(settings.textImportRules),
    directTextImport: settings.directTextImport === true,
    dictionary: normalizeDictionarySettings(settings.dictionary),
    translation: normalizeTranslationSettings(settings.translation),
    importSourceStorage: settings.importSourceStorage === 'referenced' ? 'referenced' : 'managed',
    ui: {
      ...defaultSettings.ui,
      ...settings.ui,
      fontSize: normalizeUiFontSize(settings.ui?.fontSize),
    },
  }
}

function normalizeTranslationSettings(
  value: Partial<TranslationSettingsConfiguration> | undefined,
): TranslationSettingsConfiguration {
  const supported = new Set<string>(TRANSLATION_LANGUAGES.map(({ id }) => id))
  const mainLanguage = supported.has(value?.mainLanguage ?? '')
    ? value!.mainLanguage!
    : defaultTranslationSettings.mainLanguage
  let secondaryLanguage = supported.has(value?.secondaryLanguage ?? '')
    ? value!.secondaryLanguage!
    : defaultTranslationSettings.secondaryLanguage
  if (secondaryLanguage === mainLanguage) {
    secondaryLanguage = mainLanguage === 'en' ? 'zh-Hans' : 'en'
  }
  return {
    mainLanguage,
    secondaryLanguage,
    defaultProvider: value?.defaultProvider === 'azure' ? 'azure' : 'google',
  }
}

function normalizeDictionarySettings(
  value: Partial<DictionarySettingsConfiguration> | undefined,
): DictionarySettingsConfiguration {
  return {
    zdic: {
      enabled: value?.zdic?.enabled !== false,
    },
    merriamWebster: {
      ...defaultDictionarySettings.merriamWebster,
      ...value?.merriamWebster,
      apiKey: typeof value?.merriamWebster?.apiKey === 'string' ? value.merriamWebster.apiKey : '',
      enabled: value?.merriamWebster?.enabled === true,
    },
    sourceOrder: normalizeDictionarySourceOrder(value?.sourceOrder),
  }
}

function normalizeDictionarySourceOrder(value: unknown) {
  if (!Array.isArray(value)) return [...defaultDictionarySettings.sourceOrder]

  const defaultSourceIds = new Set(defaultDictionarySettings.sourceOrder)
  const seen = new Set<string>()
  const result: string[] = []
  for (const sourceId of value) {
    if (
      typeof sourceId !== 'string' ||
      (!defaultSourceIds.has(sourceId) && !sourceId.startsWith('local:')) ||
      seen.has(sourceId)
    ) {
      continue
    }
    seen.add(sourceId)
    result.push(sourceId)
  }
  for (const sourceId of defaultDictionarySettings.sourceOrder) {
    if (!seen.has(sourceId)) result.push(sourceId)
  }
  return result
}

export function normalizeLibraryBookCardWidth(value: unknown) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : defaultLibraryBookCardWidth

  const stepped = Math.round(numeric / libraryBookCardWidthStep) * libraryBookCardWidthStep

  return Math.min(Math.max(stepped, libraryBookCardWidthMin), libraryBookCardWidthMax)
}

function normalizeLibraryDisplay(value: Partial<LibraryDisplayConfiguration> | undefined): LibraryDisplayConfiguration {
  return {
    bookCardWidth: normalizeLibraryBookCardWidth(value?.bookCardWidth),
  }
}

function normalizeLibrarySort(value: Partial<LibrarySortConfiguration> | undefined): LibrarySortConfiguration {
  const field = librarySortFieldOptions.includes(value?.field as LibrarySortField)
    ? (value?.field as LibrarySortField)
    : defaultLibrarySort.field
  const direction =
    value?.direction === 'desc' || value?.direction === 'asc' ? value.direction : defaultLibrarySort.direction

  return { field, direction }
}

export function useSettings() {
  const settings = useAppStore((state) => state.settings)
  const setSettings = useAppStore((state) => state.setSettings)
  const settingsReady = useAppStore((state) => state.settingsReady)
  const setSettingsReady = useAppStore((state) => state.setSettingsReady)

  useEffect(() => {
    if (IS_SERVER) return
    if (settingsLoaded) {
      setSettingsReady(true)
      return
    }

    let disposed = false

    loadSettings().then((settings) => {
      settingsLoaded = true
      if (!disposed) {
        setSettings(settings)
        setSettingsReady(true)
      }
    })

    return () => {
      disposed = true
    }
  }, [setSettings, setSettingsReady])

  useEffect(() => {
    if (IS_SERVER || !settingsReady) return

    updateSettingsInStorage(settings).catch(console.error)
  }, [settings, settingsReady])

  return [settings, setSettings] as const
}

export function useSettingsReady() {
  const ready = useAppStore((state) => state.settingsReady)
  const setSettings = useAppStore((state) => state.setSettings)
  const setSettingsReady = useAppStore((state) => state.setSettingsReady)

  useEffect(() => {
    if (IS_SERVER || ready) return
    if (settingsLoaded) {
      setSettingsReady(true)
      return
    }

    let disposed = false

    loadSettings().then((settings) => {
      settingsLoaded = true
      if (!disposed) {
        setSettings(settings)
        setSettingsReady(true)
      }
    })

    return () => {
      disposed = true
    }
  }, [ready, setSettings, setSettingsReady])

  return ready
}

export function useShowLibraryInTocValue() {
  return useAppStore((state) => state.settings.showLibraryInToc === true)
}

export function isRecentReadingEnabled() {
  return useAppStore.getState().settings.showRecentBooks === true
}
