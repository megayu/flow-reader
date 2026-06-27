import { useCallback, useEffect } from 'react'

import {
  AppLocale,
  defaultLocale,
  isAppLocale,
  localeOptions,
} from '../../locales'
import { useSettings, useSettingsReady } from '../state'

function getBaseLanguage(locale: string) {
  return locale.split('-')[0]?.toLowerCase() ?? locale.toLowerCase()
}

const localeByBaseLanguage = new Map(
  localeOptions.map((locale) => [getBaseLanguage(locale), locale]),
)

function getBrowserLocale(): AppLocale {
  if (typeof navigator === 'undefined') return defaultLocale

  const languages = [
    navigator.language,
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
  ]

  for (const language of languages) {
    if (isAppLocale(language)) return language

    const baseMatch = localeByBaseLanguage.get(getBaseLanguage(language))
    if (baseMatch) return baseMatch
  }

  return defaultLocale
}

export function useLocale() {
  const [settings, setSettings] = useSettings()
  const settingsReady = useSettingsReady()
  const locale = isAppLocale(settings.locale) ? settings.locale : defaultLocale

  useEffect(() => {
    if (!settingsReady || isAppLocale(settings.locale)) return

    const browserLocale = getBrowserLocale()
    if (browserLocale === defaultLocale) return

    setSettings((settings) =>
      isAppLocale(settings.locale)
        ? settings
        : { ...settings, locale: browserLocale },
    )
  }, [setSettings, settings.locale, settingsReady])

  const setLocale = useCallback(
    (locale: AppLocale) => {
      setSettings((settings) => ({ ...settings, locale }))
    },
    [setSettings],
  )

  return {
    locale,
    locales: localeOptions,
    setLocale,
  }
}
