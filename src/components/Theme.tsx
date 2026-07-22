import Head from 'next/head'
import { useEffect } from 'react'

import { defaultLocale, isAppLocale } from '../../locales'
import { useSettings } from '../state'
import { createFlowThemeCss } from '../styles/theme'
import { createAppTypographyCss } from '../styles/ui'

export function Theme() {
  const [settings] = useSettings()
  const locale = isAppLocale(settings.locale) ? settings.locale : defaultLocale

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <Head>
      <style
        id="theme"
        dangerouslySetInnerHTML={{
          __html:
            createFlowThemeCss(settings.theme) +
            createAppTypographyCss(settings.ui?.fontSize),
        }}
      ></style>
    </Head>
  )
}
