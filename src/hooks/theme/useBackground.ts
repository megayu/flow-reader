import { useCallback, useEffect, useMemo } from 'react'

import { compositeColors } from '@flow/reader/color'
import { useSettings } from '@flow/reader/state'

import { useColorScheme } from './useColorScheme'
import { useTheme } from './useTheme'

interface BackgroundOption {
  value: number
  className: string
  sidebarClassName: string
  activityBarClassName: string
  rowActiveClassName: string
  color?: string
}

export const darkBackgroundColor = '#24292e'

export const backgroundOptions: BackgroundOption[] = [
  {
    value: -1,
    className: 'bg-white',
    sidebarClassName: 'bg-[#F4F6F7]',
    activityBarClassName: 'bg-[#E8EDF0]',
    rowActiveClassName: 'bg-[#D1DEE6]',
  },
  {
    value: -2,
    className: 'bg-[#F3E8D2]',
    sidebarClassName: 'bg-[#EADBBC]',
    activityBarClassName: 'bg-[#E1CCA5]',
    rowActiveClassName: 'bg-[#D8BE94]',
    color: '#F3E8D2',
  },
  {
    value: -3,
    className: 'bg-[#E1EED8]',
    sidebarClassName: 'bg-[#D3E4C8]',
    activityBarClassName: 'bg-[#C4D8B7]',
    rowActiveClassName: 'bg-[#B7CBA8]',
    color: '#E1EED8',
  },
  {
    value: 1,
    className: 'bg-surface1',
    sidebarClassName: 'bg-surface2',
    activityBarClassName: 'bg-surface3',
    rowActiveClassName: 'bg-surface6',
  },
  {
    value: 3,
    className: 'bg-surface3',
    sidebarClassName: 'bg-surface4',
    activityBarClassName: 'bg-surface5',
    rowActiveClassName: 'bg-surface7',
  },
  {
    value: 5,
    className: 'bg-surface5',
    sidebarClassName: 'bg-surface6',
    activityBarClassName: 'bg-surface7',
    rowActiveClassName: 'bg-surface9',
  },
]

const customBackgrounds = new Map(
  backgroundOptions
    .filter((background) => background.color)
    .map((background) => [background.value, background]),
)

const backgroundOptionMap = new Map(
  backgroundOptions.map((background) => [background.value, background]),
)
const defaultBackgroundOption = backgroundOptions[0] as BackgroundOption

const darkBackground = {
  contentClassName: 'bg-default',
  sidebarClassName: 'bg-[#1D2328]',
  activityBarClassName: 'bg-[#171C20]',
  rowActiveClassName: 'bg-[#36424B]',
}

function getMaterialBackgroundOption(level: number): BackgroundOption {
  return {
    value: level,
    className: `bg-surface${level}`,
    sidebarClassName: `bg-surface${Math.min(level + 1, 7)}`,
    activityBarClassName: `bg-surface${Math.min(level + 2, 7)}`,
    rowActiveClassName: `bg-surface${Math.min(level + 5, 9)}`,
  }
}

export function useBackground() {
  const [{ theme }, setSettings] = useSettings()
  const { dark } = useColorScheme()
  const rawTheme = useTheme()

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

  // -1 is pure white; positive levels are Material surface tint levels.
  const level = theme?.background ?? -1

  const background = useMemo(() => {
    if (dark) return darkBackground

    const option =
      backgroundOptionMap.get(level) ??
      (level > 0 ? getMaterialBackgroundOption(level) : defaultBackgroundOption)

    return {
      contentClassName: option.className,
      sidebarClassName: option.sidebarClassName,
      activityBarClassName: option.activityBarClassName,
      rowActiveClassName: option.rowActiveClassName,
    }
  }, [dark, level])

  useEffect(() => {
    if (dark === undefined) return
    if (rawTheme === undefined) return

    const surfaceMap: Record<number, number> = {
      1: 0.05,
      2: 0.08,
      3: 0.11,
      4: 0.12,
      5: 0.14,
    }

    const { surface, primary } = rawTheme.schemes.light

    const customBackground = customBackgrounds.get(level)
    const color = dark
      ? darkBackgroundColor
      : customBackground?.color ??
        (level < 0
          ? '#fff'
          : compositeColors(surface, primary, surfaceMap[level]!))

    document.querySelector('#theme-color')?.setAttribute('content', color)
  }, [dark, level, rawTheme])

  return [background.contentClassName, setBackground, background] as const
}
