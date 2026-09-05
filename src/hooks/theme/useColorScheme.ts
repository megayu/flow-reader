import { useCallback, useEffect } from 'react'

import { useColorSchemeSetting } from '@/state'

import { useMediaQuery } from '../useMediaQuery'

export type ColorScheme = 'light' | 'dark' | 'system'

export function useColorScheme() {
  const [configuredScheme, setSettings] = useColorSchemeSetting()
  const scheme = configuredScheme ?? 'light'
  const setScheme = useCallback(
    (scheme: ColorScheme) => {
      setSettings((prev) => ({
        ...prev,
        theme: {
          ...prev.theme,
          scheme,
        },
      }))
    },
    [setSettings],
  )

  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  const dark = scheme === 'dark' || (scheme === 'system' && prefersDark)

  useEffect(() => {
    if (dark !== undefined) {
      document.documentElement.classList.toggle('dark', dark)
    }
  }, [dark])

  return { scheme, dark, setScheme }
}
