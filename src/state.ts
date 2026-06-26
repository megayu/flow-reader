import { useEffect } from 'react'
import { create } from 'zustand'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { IS_SERVER } from '@flow/reader/env'
import { AppLocale } from '@flow/reader/locales'
import {
  normalizeThemeConfiguration,
  type ThemeConfiguration,
} from '@flow/reader/styles/theme'
import { defaultUiFontSize, normalizeUiFontSize } from '@flow/reader/styles/ui'

import {
  getSettingsFromStorage,
  updateSettingsInStorage,
  type ReadingStatus,
} from './db'

export type SetterOrUpdater<T> = (value: T | ((prev: T) => T)) => void

export type ViewMode = 'reader' | 'library'
export type Action = 'toc' | 'search' | 'annotation' | 'typography' | 'image'
export type LibraryAction = 'libraryFilter'
export type LibrarySortField = 'title' | 'creator' | 'updatedAt' | 'createdAt'
export type LibrarySortDirection = 'asc' | 'desc'

export interface Settings extends TypographyConfiguration {
  theme?: ThemeConfiguration
  ui?: UiConfiguration
  enableTextSelectionMenu?: boolean
  hideEndnotes?: boolean
  restoreLastReadingOnStartup?: boolean
  startupSession?: StartupSession
  readerSidebarOpen?: boolean
  librarySidebarOpen?: boolean
  libraryDisplay?: LibraryDisplayConfiguration
  librarySort?: LibrarySortConfiguration
  libraryPinnedAuthors?: string[]
  libraryPinnedTags?: string[]
  textImportRules?: TextImportRulesConfiguration
  locale?: AppLocale
}

export interface TypographyConfiguration {
  fontSize?: string
  fontWeight?: number
  fontFamily?: string
  lineHeight?: number
  textIndent?: number
  textAlign?: 'default' | 'justify'
  spread?: RenditionSpread
  zoom?: number
}

interface UiConfiguration {
  fontSize?: number
}

interface StartupSession {
  viewMode?: ViewMode
  bookId?: string
}

export interface LibrarySortConfiguration {
  field: LibrarySortField
  direction: LibrarySortDirection
}

export interface LibraryDisplayConfiguration {
  bookCardWidth: number
}

export interface TextImportRulesConfiguration {
  groupPatterns: string[]
  chapterPatterns: string[]
}

export const librarySortFieldOptions: LibrarySortField[] = [
  'title',
  'creator',
  'updatedAt',
  'createdAt',
]

export const defaultLibrarySort: LibrarySortConfiguration = {
  field: 'title',
  direction: 'asc',
}

export const libraryBookCardWidthMin = 120
export const libraryBookCardWidthMax = 240
export const libraryBookCardWidthStep = 10
export const defaultLibraryBookCardWidth = 160

export const defaultLibraryDisplay: LibraryDisplayConfiguration = {
  bookCardWidth: defaultLibraryBookCardWidth,
}

export const defaultTextImportRules: TextImportRulesConfiguration = {
  groupPatterns: [
    '^\\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[卷部集篇].*',
    '^\\s*(Book|Part|Volume)\\s+[0-9IVXLCDM]+.*',
  ],
  chapterPatterns: [
    '^\\s*第[0-9一二三四五六七八九十零〇百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节].*',
    '^\\s*(简介|序言|序|前言|自序|楔子|后记|尾声|番外|附录).*',
    '^\\s*Chapter\\s+[0-9IVXLCDM]+.*',
  ],
}

export const defaultSettings: Settings = {
  enableTextSelectionMenu: true,
  hideEndnotes: false,
  readerSidebarOpen: true,
  librarySidebarOpen: false,
  libraryDisplay: defaultLibraryDisplay,
  librarySort: defaultLibrarySort,
  textImportRules: defaultTextImportRules,
  ui: {
    fontSize: defaultUiFontSize,
  },
}

interface AppStore {
  action?: Action
  libraryAction?: LibraryAction
  libraryAuthorFilter: string[]
  libraryStatusFilter: ReadingStatus[]
  libraryTagFilter: string[]
  settings: Settings
  settingsDialogOpen: boolean
  settingsReady: boolean
  viewMode: ViewMode
  zenMode: boolean
  zenTypographyOverrides: Record<string, TypographyConfiguration>
  setAction: SetterOrUpdater<Action | undefined>
  setLibraryAction: SetterOrUpdater<LibraryAction | undefined>
  setLibraryAuthorFilter: SetterOrUpdater<string[]>
  setLibraryStatusFilter: SetterOrUpdater<ReadingStatus[]>
  setLibraryTagFilter: SetterOrUpdater<string[]>
  setSettings: SetterOrUpdater<Settings>
  setSettingsDialogOpen: SetterOrUpdater<boolean>
  setSettingsReady: SetterOrUpdater<boolean>
  setViewMode: SetterOrUpdater<ViewMode>
  setZenMode: SetterOrUpdater<boolean>
  setZenTypographyOverrides: SetterOrUpdater<
    Record<string, TypographyConfiguration>
  >
}

function resolveUpdate<T>(value: T | ((prev: T) => T), prev: T) {
  return typeof value === 'function' ? (value as (prev: T) => T)(prev) : value
}

export const useAppStore = create<AppStore>((set) => ({
  action: undefined,
  libraryAction: undefined,
  libraryAuthorFilter: [],
  libraryStatusFilter: [],
  libraryTagFilter: [],
  settings: defaultSettings,
  settingsDialogOpen: false,
  settingsReady: false,
  viewMode: 'library',
  zenMode: false,
  zenTypographyOverrides: {},
  setAction: (value) =>
    set((state) => ({ action: resolveUpdate(value, state.action) })),
  setLibraryAction: (value) =>
    set((state) => ({
      libraryAction: resolveUpdate(value, state.libraryAction),
    })),
  setLibraryAuthorFilter: (value) =>
    set((state) => ({
      libraryAuthorFilter: resolveUpdate(value, state.libraryAuthorFilter),
    })),
  setLibraryStatusFilter: (value) =>
    set((state) => ({
      libraryStatusFilter: resolveUpdate(value, state.libraryStatusFilter),
    })),
  setLibraryTagFilter: (value) =>
    set((state) => ({
      libraryTagFilter: resolveUpdate(value, state.libraryTagFilter),
    })),
  setSettings: (value) =>
    set((state) => ({ settings: resolveUpdate(value, state.settings) })),
  setSettingsDialogOpen: (value) =>
    set((state) => ({
      settingsDialogOpen: resolveUpdate(value, state.settingsDialogOpen),
    })),
  setSettingsReady: (value) =>
    set((state) => ({
      settingsReady: resolveUpdate(value, state.settingsReady),
    })),
  setViewMode: (value) =>
    set((state) => ({ viewMode: resolveUpdate(value, state.viewMode) })),
  setZenMode: (value) =>
    set((state) => ({ zenMode: resolveUpdate(value, state.zenMode) })),
  setZenTypographyOverrides: (value) =>
    set((state) => ({
      zenTypographyOverrides: resolveUpdate(
        value,
        state.zenTypographyOverrides,
      ),
    })),
}))

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

export function useLibraryTagFilter() {
  const filters = useAppStore((state) => state.libraryTagFilter)
  const setFilters = useAppStore((state) => state.setLibraryTagFilter)

  return [filters, setFilters] as const
}

export function useSettingsDialogOpen() {
  const open = useAppStore((state) => state.settingsDialogOpen)
  const setOpen = useAppStore((state) => state.setSettingsDialogOpen)

  return [open, setOpen] as const
}

export function useSetSettingsDialogOpen() {
  return useAppStore((state) => state.setSettingsDialogOpen)
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
    .then((value) => normalizeSettings(value))
    .catch(() => defaultSettings)

  return settingsLoadPromise
}

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  const settings = { ...defaultSettings, ...value }

  return {
    ...settings,
    theme: normalizeThemeConfiguration(settings.theme),
    libraryDisplay: normalizeLibraryDisplay(settings.libraryDisplay),
    librarySort: normalizeLibrarySort(settings.librarySort),
    libraryPinnedAuthors: normalizeStringList(settings.libraryPinnedAuthors),
    libraryPinnedTags: normalizeStringList(settings.libraryPinnedTags),
    textImportRules: {
      ...defaultTextImportRules,
      ...settings.textImportRules,
    },
    ui: {
      ...defaultSettings.ui,
      ...settings.ui,
      fontSize: normalizeUiFontSize(settings.ui?.fontSize),
    },
  }
}

export function normalizeLibraryBookCardWidth(value: unknown) {
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : defaultLibraryBookCardWidth

  const stepped =
    Math.round(numeric / libraryBookCardWidthStep) * libraryBookCardWidthStep

  return Math.min(
    Math.max(stepped, libraryBookCardWidthMin),
    libraryBookCardWidthMax,
  )
}

function normalizeLibraryDisplay(
  value: Partial<LibraryDisplayConfiguration> | undefined,
): LibraryDisplayConfiguration {
  return {
    bookCardWidth: normalizeLibraryBookCardWidth(value?.bookCardWidth),
  }
}

function normalizeLibrarySort(
  value: Partial<LibrarySortConfiguration> | undefined,
): LibrarySortConfiguration {
  const field = librarySortFieldOptions.includes(
    value?.field as LibrarySortField,
  )
    ? (value?.field as LibrarySortField)
    : defaultLibrarySort.field
  const direction =
    value?.direction === 'desc' || value?.direction === 'asc'
      ? value.direction
      : defaultLibrarySort.direction

  return { field, direction }
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const list: string[] = []
  value.forEach((item) => {
    if (typeof item !== 'string') return

    const normalized = item.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) return

    seen.add(normalized)
    list.push(normalized)
  })

  return list
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
