import {
  themeFromSourceColor,
  argbFromHex,
} from '@material/material-color-utilities'
import Head from 'next/head'
import { useEffect, useMemo } from 'react'

import { useSourceColor } from '../hooks/theme/useSourceColor'
import { useSetTheme } from '../hooks/theme/useTheme'
import { createThemeCss } from '../styles/theme'

export function Theme() {
  const { sourceColor } = useSourceColor()
  const setTheme = useSetTheme()

  const theme = useMemo(
    () => themeFromSourceColor(argbFromHex(sourceColor)),
    [sourceColor],
  )

  useEffect(() => {
    setTheme(theme)
  }, [setTheme, theme])

  return (
    <Head>
      <style
        id="theme"
        dangerouslySetInnerHTML={{ __html: createThemeCss(theme) }}
      ></style>
    </Head>
  )
}
