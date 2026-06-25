import Head from 'next/head'

import { useSettings } from '../state'
import { createFlowThemeCss } from '../styles/theme'
import { createAppTypographyCss } from '../styles/ui'

export function Theme() {
  const [settings] = useSettings()

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
