import { useEffect } from 'react'

import { annotationHighlightOpacity } from '../annotation'
import { fallbackLocale, isAppLocale } from '../locales'
import { useSettings } from '../state'
import { createFlowThemeCss } from '../styles/theme'
import { createAppTypographyCss } from '../styles/ui'

export function Theme() {
  const [settings] = useSettings()
  const locale = isAppLocale(settings.locale) ? settings.locale : fallbackLocale
  const highlightOpacity = settings.annotationHighlightOpacity ?? annotationHighlightOpacity.defaultValue

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    document.documentElement.style.setProperty('--flow-annotation-highlight-opacity', String(highlightOpacity / 100))
  }, [highlightOpacity])

  const themeCss = createFlowThemeCss(settings.theme) + createAppTypographyCss(settings.ui?.fontSize)

  return <style id="theme">{themeCss}</style>
}
