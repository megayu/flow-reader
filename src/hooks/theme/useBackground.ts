import { useCallback, useEffect, useMemo } from 'react'

import { useSettings } from '@flow/reader/state'
import {
  backgroundOptions,
  createBackgroundPalette,
  customBackgroundValue,
  darkBackgroundColor,
  defaultCustomBackgroundColor,
  isDarkPaletteColor,
  normalizePaletteColor,
  type BackgroundOption,
  type BackgroundPalette,
} from '@flow/reader/styles/theme'

import { useColorScheme } from './useColorScheme'

export {
  backgroundOptions,
  createBackgroundPalette,
  customBackgroundValue,
  darkBackgroundColor,
  defaultCustomBackgroundColor,
  isDarkPaletteColor,
  normalizePaletteColor,
}
export type { BackgroundPalette }

const backgroundOptionMap = new Map(
  backgroundOptions.map((background) => [background.value, background]),
)
const defaultBackgroundOption = backgroundOptions[0] as BackgroundOption

const backgroundClassNames = {
  contentClassName: 'flow-bg-content',
  sidebarClassName: 'flow-bg-sidebar',
  activityBarClassName: 'flow-bg-activity',
  rowActiveClassName: 'flow-bg-active',
}

export function useBackground() {
  const [{ theme }, setSettings] = useSettings()
  const { dark } = useColorScheme()

  const setBackground = useCallback(
    (background: number) => {
      setSettings((prev) => ({
        ...prev,
        theme: {
          ...prev.theme,
          background,
        },
      }))
    },
    [setSettings],
  )

  const level = theme?.background ?? -1
  const customBackground = theme?.customBackground

  const palette = useMemo(() => {
    const customColor = normalizePaletteColor(customBackground)

    if (level === customBackgroundValue) {
      return createBackgroundPalette(
        customColor ?? defaultCustomBackgroundColor,
      )
    }

    if (dark) return createBackgroundPalette(darkBackgroundColor)

    const color =
      backgroundOptionMap.get(level)?.color ?? defaultBackgroundOption.color

    return createBackgroundPalette(color)
  }, [customBackground, dark, level])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--flow-bg-content', palette.content)
    root.style.setProperty('--flow-bg-sidebar', palette.sidebar)
    root.style.setProperty('--flow-bg-activity', palette.activity)
    root.style.setProperty('--flow-bg-active', palette.active)
    document
      .querySelector('#theme-color')
      ?.setAttribute('content', palette.content)
  }, [palette])

  return [
    backgroundClassNames.contentClassName,
    setBackground,
    backgroundClassNames,
  ] as const
}
