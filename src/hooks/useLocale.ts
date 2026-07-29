import { useCallback } from 'react'

import { type AppLocale, fallbackLocale, isAppLocale, localeOptions } from '../locales'
import { useSettings } from '../state'

export function useLocale() {
  const [settings, setSettings] = useSettings()
  const locale = isAppLocale(settings.locale) ? settings.locale : fallbackLocale

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
