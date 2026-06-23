import type { Theme } from '@material/material-color-utilities'
import { useEffect } from 'react'
import { create } from 'zustand'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { IS_SERVER } from '@flow/reader/env'
import type { ColorScheme } from '@flow/reader/hooks/theme/useColorScheme'
import { AppLocale } from '@flow/reader/locales'

import {
  getSettingsFromStorage,
  updateSettingsInStorage,
  type ReadingStatus,
} from './db'

export type SetterOrUpdater<T> = (value: T | ((prev: T) => T)) => void

export type ViewMode = 'reader' | 'library'
export type Action = 'toc' | 'search' | 'annotation' | 'typography' | 'image'
export type LibraryAction = 'libraryFilter'

export interface Settings extends TypographyConfiguration {
  theme?: ThemeConfiguration
  enableTextSelectionMenu?: boolean
  hideEndnotes?: boolean
  restoreLastReadingOnStartup?: boolean
  startupSession?: StartupSession
  readerSidebarOpen?: boolean
  librarySidebarOpen?: boolean
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

interface ThemeConfiguration {
  source?: string
  background?: number
  customBackground?: string
  scheme?: ColorScheme
}

interface StartupSession {
  viewMode?: ViewMode
  bookId?: string
}

export interface TextImportRulesConfiguration {
  groupPatterns: string[]
  chapterPatterns: string[]
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
  textImportRules: defaultTextImportRules,
}

interface AppStore {
  action?: Action
  libraryAction?: LibraryAction
  libraryStatusFilter: ReadingStatus[]
  settings: Settings
  settingsDialogOpen: boolean
  settingsReady: boolean
  theme?: Theme
  viewMode: ViewMode
  zenMode: boolean
  zenTypographyOverrides: Record<string, TypographyConfiguration>
  setAction: SetterOrUpdater<Action | undefined>
  setLibraryAction: SetterOrUpdater<LibraryAction | undefined>
  setLibraryStatusFilter: SetterOrUpdater<ReadingStatus[]>
  setSettings: SetterOrUpdater<Settings>
  setSettingsDialogOpen: SetterOrUpdater<boolean>
  setSettingsReady: SetterOrUpdater<boolean>
  setTheme: SetterOrUpdater<Theme | undefined>
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
  libraryStatusFilter: [],
  settings: defaultSettings,
  settingsDialogOpen: false,
  settingsReady: false,
  theme: undefined,
  viewMode: 'library',
  zenMode: false,
  zenTypographyOverrides: {},
  setAction: (value) =>
    set((state) => ({ action: resolveUpdate(value, state.action) })),
  setLibraryAction: (value) =>
    set((state) => ({
      libraryAction: resolveUpdate(value, state.libraryAction),
    })),
  setLibraryStatusFilter: (value) =>
    set((state) => ({
      libraryStatusFilter: resolveUpdate(value, state.libraryStatusFilter),
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
  setTheme: (value) =>
    set((state) => ({ theme: resolveUpdate(value, state.theme) })),
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

export function useSettingsDialogOpen() {
  const open = useAppStore((state) => state.settingsDialogOpen)
  const setOpen = useAppStore((state) => state.setSettingsDialogOpen)

  return [open, setOpen] as const
}

export function useSetSettingsDialogOpen() {
  return useAppStore((state) => state.setSettingsDialogOpen)
}

export function useThemeValue() {
  return useAppStore((state) => state.theme)
}

export function useSetThemeValue() {
  return useAppStore((state) => state.setTheme)
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
    .then((value) => ({ ...defaultSettings, ...value }))
    .catch(() => defaultSettings)

  return settingsLoadPromise
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
