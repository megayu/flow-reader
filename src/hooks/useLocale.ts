import { useCallback, useEffect } from 'react'

import {
  AppLocale,
  defaultLocale,
  isAppLocale,
  localeOptions,
} from '../../locales'
import { useSettings, useSettingsReady } from '../state'

function getBrowserLocale(): AppLocale {
  if (typeof navigator === 'undefined') return defaultLocale

  const languages = [
    navigator.language,
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
  ]

  for (const language of languages) {
    if (isAppLocale(language)) return language

    const baseMatch = localeOptions.find((locale) =>
      locale.toLowerCase().startsWith(`${language.split('-')[0]}-`),
    )
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
