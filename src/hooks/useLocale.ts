import { useCallback } from 'react'

import { type AppLocale, fallbackLocale, isAppLocale, localeOptions } from '../locales'
import { useSettingsLocale } from '../state'

export function useLocale() {
  const [settingsLocale, setSettings] = useSettingsLocale()
  const locale = isAppLocale(settingsLocale) ? settingsLocale : fallbackLocale

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
