import { useEffect } from 'react'

import { defaultLocale, isAppLocale } from '../locales'
import { useSettings } from '../state'
import { createFlowThemeCss } from '../styles/theme'
import { createAppTypographyCss } from '../styles/ui'

export function Theme() {
  const [settings] = useSettings()
  const locale = isAppLocale(settings.locale) ? settings.locale : defaultLocale

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const themeCss = createFlowThemeCss(settings.theme) + createAppTypographyCss(settings.ui?.fontSize)

  return <style id="theme">{themeCss}</style>
}
