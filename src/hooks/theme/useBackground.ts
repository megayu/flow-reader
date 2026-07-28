import { useCallback } from 'react'

import { useSettings } from '@/state'
import {
  type BackgroundPalette,
  type BackgroundPresetId,
  backgroundOptions,
  backgroundPresets,
  createBackgroundPalette,
  customBackgroundValue,
  darkBackgroundColor,
  defaultCustomBackgroundColor,
  isDarkPaletteColor,
  normalizePaletteColor,
} from '@/styles/theme'

export type { BackgroundPalette }
export {
  backgroundOptions,
  backgroundPresets,
  createBackgroundPalette,
  customBackgroundValue,
  darkBackgroundColor,
  defaultCustomBackgroundColor,
  isDarkPaletteColor,
  normalizePaletteColor,
}

const legacyBackgroundPresetMap: Record<number, BackgroundPresetId> = {
  [-1]: 'clean',
  1: 'clean',
  [-2]: 'sepia',
  [-3]: 'sage',
  3: 'mist',
  5: 'mist',
  [customBackgroundValue]: 'custom',
}

const backgroundClassNames = {
  contentClassName: 'flow-bg-content',
  sidebarClassName: 'flow-bg-sidebar',
  activityBarClassName: 'flow-bg-activity',
  rowActiveClassName: 'flow-bg-active',
}

export function useBackground() {
  const [, setSettings] = useSettings()

  const setBackground = useCallback(
    (background: number) => {
      setSettings((prev) => ({
        ...prev,
        theme: {
          ...prev.theme,
          backgroundPreset: legacyBackgroundPresetMap[background] ?? 'clean',
          scheme:
            background === customBackgroundValue
              ? prev.theme?.scheme
              : legacyBackgroundPresetMap[background] === 'custom'
                ? prev.theme?.scheme
                : 'light',
        },
      }))
    },
    [setSettings],
  )

  return [backgroundClassNames.contentClassName, setBackground, backgroundClassNames] as const
}
