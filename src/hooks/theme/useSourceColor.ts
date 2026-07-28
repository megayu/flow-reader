import { useCallback } from 'react'

import { useSettings } from '@/state'
import { defaultAccentColor, normalizePaletteColor } from '@/styles/theme'

export function useAccentColor() {
  const [{ theme }, setSettings] = useSettings()
  const accentColor = normalizePaletteColor(theme?.accent ?? theme?.source) ?? defaultAccentColor

  const setAccentColor = useCallback(
    (accent: string) => {
      setSettings((prev) => ({
        ...prev,
        theme: {
          ...prev.theme,
          accent,
        },
      }))
    },
    [setSettings],
  )

  return { accentColor, setAccentColor }
}

export function useSourceColor() {
  const { accentColor, setAccentColor } = useAccentColor()

  return {
    sourceColor: accentColor,
    setSourceColor: setAccentColor,
  }
}
