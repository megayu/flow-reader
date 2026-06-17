import {
  themeFromSourceColor,
  argbFromHex,
  Theme,
} from '@material/material-color-utilities'
import Head from 'next/head'
import { useEffect, useMemo } from 'react'

import { rgbFromArgb } from '../color'
import { useSetTheme, useSourceColor } from '../hooks'
import { range } from '../utils'

// let `tailwindcss` generate classes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const classNamesToGenerate = [
  'bg-surface',
  'bg-surface1',
  'bg-surface2',
  'bg-surface3',
  'bg-surface4',
  'bg-surface5',
  'bg-[#F3E8D2]',
  'bg-[#E1EED8]',
  'bg-[#F4F6F7]',
  'bg-[#E8EDF0]',
  'bg-[#DDE5EA]',
  'bg-[#EADBBC]',
  'bg-[#E1CCA5]',
  'bg-[#D8BE94]',
  'bg-[#D3E4C8]',
  'bg-[#C4D8B7]',
  'bg-[#B7CBA8]',
  'hover:bg-surface',
  'hover:bg-surface1',
  'hover:bg-surface2',
  'hover:bg-surface3',
  'hover:bg-surface4',
  'hover:bg-surface5',
]

function camelToSnake(s: string) {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

function generateCss(theme: Theme) {
  const tones = range(4).map((i) => (i + 5) * 10)
  const generateRef = () => {
    return Object.entries(theme.palettes)
      .flatMap(([k, palette]) =>
        tones.map((i) => {
          const argb = palette.tone(i)
          const rgb = rgbFromArgb(argb).join(' ')
          return `--md-ref-palette-${camelToSnake(k)}${i}:${rgb};`
        }),
      )
      .join('')
  }

  const generateSys = (schemeName: 'light' | 'dark') => {
    let css = `color-scheme: ${schemeName};`
    const scheme = theme.schemes[schemeName]
    Object.entries(scheme.toJSON()).forEach(([key, argb]) => {
      const token = camelToSnake(key)
      const rgb = rgbFromArgb(argb).join(' ')
      css += `--md-sys-color-${token}:${rgb};`
    })
    return css
  }

  return (
    `:root {${generateRef()}}` +
    `:root, .light {${generateSys('light')}}` +
    `:root.dark {${generateSys('dark')}}`
  )
}

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
        dangerouslySetInnerHTML={{ __html: generateCss(theme) }}
      ></style>
    </Head>
  )
}
