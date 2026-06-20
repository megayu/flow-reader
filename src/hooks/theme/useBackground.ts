import { useCallback, useEffect, useMemo } from 'react'

import { useSettings } from '@flow/reader/state'

import { useColorScheme } from './useColorScheme'

interface BackgroundOption {
  value: number
  color: string
}

export interface BackgroundPalette {
  content: string
  sidebar: string
  activity: string
  active: string
}

export const customBackgroundValue = 0
export const defaultCustomBackgroundColor = '#E1EED8'
export const darkBackgroundColor = '#24292E'

export const backgroundOptions: BackgroundOption[] = [
  { value: -1, color: '#FFFFFF' },
  { value: 1, color: '#F4F6F7' },
  { value: -2, color: '#F3E8D2' },
  { value: -3, color: '#E1EED8' },
  { value: 3, color: '#DDE5EA' },
  { value: 5, color: '#D1DEE6' },
]

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

export function createBackgroundPalette(color: string): BackgroundPalette {
  const content = normalizePaletteColor(color) ?? '#FFFFFF'

  return {
    content,
    sidebar: darkenHexColor(content, 0.06),
    activity: darkenHexColor(content, 0.12),
    active: darkenHexColor(content, 0.18),
  }
}

function darkenHexColor(color: string, amount: number) {
  const rgb = hexToRgb(color)
  if (!rgb) return color

  return rgbToHex(
    rgb.map((channel) => Math.round(channel * (1 - amount))) as RgbColor,
  )
}

type RgbColor = [number, number, number]

function hexToRgb(color: string): RgbColor | undefined {
  const normalized = normalizePaletteColor(color)
  if (!normalized) return

  return [
    parseInt(normalized.slice(1, 3), 16),
    parseInt(normalized.slice(3, 5), 16),
    parseInt(normalized.slice(5, 7), 16),
  ]
}

function rgbToHex(rgb: RgbColor) {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

export function normalizePaletteColor(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return

  const hex = raw.startsWith('#') ? raw.slice(1) : raw
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex
      .split('')
      .map((char) => `${char}${char}`)
      .join('')
      .toUpperCase()}`
  }

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toUpperCase()}`
  }
}

export function isDarkPaletteColor(color: string | undefined) {
  const rgb = color ? hexToRgb(color) : undefined
  if (!rgb) return false

  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }) as RgbColor

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance < 0.45
}
