import { IS_SERVER } from '@literal-ui/hooks'
import { useEffect } from 'react'
import { atom, useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import type { ColorScheme } from '@flow/reader/hooks/theme/useColorScheme'
import { AppLocale } from '@flow/reader/locales'

import { getSettingsFromStorage, updateSettingsInStorage } from './db'

export const navbarState = atom<boolean>({
  key: 'navbar',
  default: false,
})

export type ViewMode = 'reader' | 'library'
export const viewModeState = atom<ViewMode>({
  key: 'viewMode',
  default: 'library',
})

export const zenModeState = atom<boolean>({
  key: 'zenMode',
  default: false,
})

export const zenTypographyOverridesState = atom<
  Record<string, TypographyConfiguration>
>({
  key: 'zenTypographyOverrides',
  default: {},
})

export const settingsDialogOpenState = atom<boolean>({
  key: 'settingsDialogOpen',
  default: false,
})

export interface Settings extends TypographyConfiguration {
  theme?: ThemeConfiguration
  enableTextSelectionMenu?: boolean
  hideEndnotes?: boolean
  restoreLastReadingOnStartup?: boolean
  startupSession?: StartupSession
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

export const defaultSettings: Settings = {
  enableTextSelectionMenu: true,
  hideEndnotes: false,
}

const settingsState = atom<Settings>({
  key: 'settings',
  default: defaultSettings,
})

const settingsReadyState = atom<boolean>({
  key: 'settingsReady',
  default: false,
})

let settingsLoaded = false
let settingsLoadPromise: Promise<Settings> | undefined

function loadSettings() {
  settingsLoadPromise ??= getSettingsFromStorage<Partial<Settings>>()
    .then((value) => ({ ...defaultSettings, ...value }))
    .catch(() => defaultSettings)

  return settingsLoadPromise
}

export function useSettings() {
  const [settings, setSettings] = useRecoilState(settingsState)
  const settingsReady = useRecoilValue(settingsReadyState)
  const setSettingsReady = useSetRecoilState(settingsReadyState)

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
  const ready = useRecoilValue(settingsReadyState)
  const setSettings = useSetRecoilState(settingsState)
  const setSettingsReady = useSetRecoilState(settingsReadyState)

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
