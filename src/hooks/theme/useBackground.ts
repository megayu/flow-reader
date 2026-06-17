import { useCallback, useEffect, useMemo } from 'react'

import { compositeColors } from '@flow/reader/color'
import { useSettings } from '@flow/reader/state'

import { useColorScheme } from './useColorScheme'
import { useTheme } from './useTheme'

export const backgroundOptions = [
  { value: -1, className: 'bg-white' },
  { value: -2, className: 'bg-[#F3E8D2]', color: '#F3E8D2' },
  { value: -3, className: 'bg-[#E1EED8]', color: '#E1EED8' },
  { value: 1, className: 'bg-surface1' },
  { value: 3, className: 'bg-surface3' },
  { value: 5, className: 'bg-surface5' },
]

const customBackgrounds = new Map(
  backgroundOptions
    .filter((background) => background.color)
    .map((background) => [background.value, background]),
)

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
    if (dark) return 'bg-default'

    const customBackground = customBackgrounds.get(level)
    if (customBackground) return customBackground.className

    if (level > 0) return `bg-surface${level}`

    return 'bg-default'
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
      ? '#24292e'
      : customBackground?.color ??
        (level < 0
          ? '#fff'
          : compositeColors(surface, primary, surfaceMap[level]!))

    document.querySelector('#theme-color')?.setAttribute('content', color)
  }, [dark, level, rawTheme])

  return [background, setBackground] as const
}
