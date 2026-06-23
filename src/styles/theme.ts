import type { Theme as MaterialTheme } from '@material/material-color-utilities'

type SchemeName = 'light' | 'dark'
type SchemeTokens = Record<string, number>

export interface BackgroundOption {
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

const shadcnTokenMap: [string, string][] = [
  ['--background', 'background'],
  ['--foreground', 'onBackground'],
  ['--card', 'surface'],
  ['--card-foreground', 'onSurface'],
  ['--popover', 'surface'],
  ['--popover-foreground', 'onSurface'],
  ['--primary', 'primary'],
  ['--primary-foreground', 'onPrimary'],
  ['--secondary', 'secondaryContainer'],
  ['--secondary-foreground', 'onSecondaryContainer'],
  ['--muted', 'surfaceVariant'],
  ['--muted-foreground', 'onSurfaceVariant'],
  ['--accent', 'tertiaryContainer'],
  ['--accent-foreground', 'onTertiaryContainer'],
  ['--destructive', 'error'],
  ['--destructive-foreground', 'onError'],
  ['--border', 'outlineVariant'],
  ['--input', 'outlineVariant'],
  ['--ring', 'primary'],
  ['--chart-1', 'primary'],
  ['--chart-2', 'secondary'],
  ['--chart-3', 'tertiary'],
  ['--chart-4', 'error'],
  ['--chart-5', 'outline'],
  ['--sidebar', 'surface'],
  ['--sidebar-foreground', 'onSurface'],
  ['--sidebar-primary', 'primary'],
  ['--sidebar-primary-foreground', 'onPrimary'],
  ['--sidebar-accent', 'secondaryContainer'],
  ['--sidebar-accent-foreground', 'onSecondaryContainer'],
  ['--sidebar-border', 'outlineVariant'],
  ['--sidebar-ring', 'primary'],
]

function rgbTripletFromArgb(argb: number) {
  const r = (argb >> 16) & 255
  const g = (argb >> 8) & 255
  const b = argb & 255
  return `${r} ${g} ${b}`
}

function cssColorFromArgb(argb: number) {
  return `rgb(${rgbTripletFromArgb(argb)})`
}

function declarationsToCss(declarations: [string, string][]) {
  return declarations
    .map(([property, value]) => `${property}:${value};`)
    .join('')
}

function createSchemeDeclarations(
  theme: MaterialTheme,
  schemeName: SchemeName,
) {
  const scheme = theme.schemes[schemeName].toJSON() as SchemeTokens
  const shadcnDeclarations = shadcnTokenMap.flatMap(([token, schemeKey]) => {
    const argb = scheme[schemeKey]
    return typeof argb === 'number'
      ? [[token, cssColorFromArgb(argb)] as [string, string]]
      : []
  })

  return [
    ['color-scheme', schemeName] as [string, string],
    ...shadcnDeclarations,
  ]
}

export function createThemeCss(theme: MaterialTheme) {
  return (
    `:root, .light {${declarationsToCss(
      createSchemeDeclarations(theme, 'light'),
    )}}` +
    `:root.dark {${declarationsToCss(createSchemeDeclarations(theme, 'dark'))}}`
  )
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
