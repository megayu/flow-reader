import { normalizeHexColor as normalizePaletteColor } from '../color'

export { normalizePaletteColor }

type SchemeName = 'light' | 'dark'

export type FlowThemeScheme = 'light' | 'dark' | 'system'
export type FlowThemeContrast = 'standard' | 'high'
export type BackgroundPresetId =
  | 'clean'
  | 'neutral'
  | 'paper'
  | 'sepia'
  | 'sage'
  | 'mist'
  | 'dusk'
  | 'rose'
  | 'charcoal'
  | 'black'
  | 'custom'

export interface ThemeConfiguration {
  backgroundPreset?: BackgroundPresetId
  customBackground?: string
  accent?: string
  scheme?: FlowThemeScheme
  contrast?: FlowThemeContrast
  /**
   * Legacy Material source color. Kept so stored settings migrate without data
   * loss when older app versions are opened.
   */
  source?: string
  /**
   * Legacy numeric background level. Kept only for settings migration.
   */
  background?: number
}

export interface NormalizedThemeConfiguration {
  backgroundPreset: BackgroundPresetId
  customBackground?: string
  accent: string
  scheme: FlowThemeScheme
  contrast: FlowThemeContrast
}

export interface BackgroundPreset {
  id: Exclude<BackgroundPresetId, 'custom'>
  label: string
  lightSeed: string
  darkSeed: string
  defaultAccent: string
  mode: SchemeName
}

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

type FlowThemeTokenName =
  | '--flow-bg-app'
  | '--flow-bg-activity'
  | '--flow-bg-sidebar'
  | '--flow-bg-content'
  | '--flow-bg-tabbar'
  | '--flow-bg-tab-active'
  | '--flow-bg-panel'
  | '--flow-bg-control'
  | '--flow-bg-control-hover'
  | '--flow-bg-control-active'
  | '--flow-sidebar-item-bg'
  | '--flow-sidebar-item-bg-hover'
  | '--flow-sidebar-item-bg-active'
  | '--flow-sidebar-item-border'
  | '--flow-text'
  | '--flow-text-muted'
  | '--flow-border'
  | '--flow-border-strong'
  | '--flow-tab-border'
  | '--flow-tab-border-strong'
  | '--flow-accent'
  | '--flow-accent-text'
  | '--flow-accent-bg'
  | '--flow-accent-bg-hover'
  | '--flow-accent-border'
  | '--flow-focus-ring'
  | '--flow-success'
  | '--flow-warning'
  | '--flow-danger'
  | '--flow-danger-bg'
  | '--flow-danger-bg-hover'
  | '--flow-danger-text'

export type FlowThemeTokens = Record<FlowThemeTokenName, string>

export const customBackgroundValue = 0
export const defaultCustomBackgroundColor = '#E1EED8'
export const darkBackgroundColor = '#24292E'
export const defaultAccentColor = '#0EA5E9'

export const backgroundPresets: BackgroundPreset[] = [
  {
    id: 'clean',
    label: 'Clean',
    lightSeed: '#FFFFFF',
    darkSeed: '#15191D',
    defaultAccent: defaultAccentColor,
    mode: 'light',
  },
  {
    id: 'neutral',
    label: 'Neutral',
    lightSeed: '#E5E5E2',
    darkSeed: '#252626',
    defaultAccent: '#2F6F8F',
    mode: 'light',
  },
  {
    id: 'paper',
    label: 'Paper',
    lightSeed: '#F6F1E6',
    darkSeed: '#28241E',
    defaultAccent: '#2563EB',
    mode: 'light',
  },
  {
    id: 'sepia',
    label: 'Sepia',
    lightSeed: '#F1DFC1',
    darkSeed: '#2A2118',
    defaultAccent: '#8B5E34',
    mode: 'light',
  },
  {
    id: 'rose',
    label: 'Rose',
    lightSeed: '#F3E1E5',
    darkSeed: '#301F27',
    defaultAccent: '#BE3A5B',
    mode: 'light',
  },
  {
    id: 'sage',
    label: 'Sage',
    lightSeed: '#E1EED8',
    darkSeed: '#1E2A23',
    defaultAccent: '#2F7D68',
    mode: 'light',
  },
  {
    id: 'mist',
    label: 'Mist',
    lightSeed: '#DDE7EC',
    darkSeed: '#1D2730',
    defaultAccent: '#2563EB',
    mode: 'light',
  },
  {
    id: 'dusk',
    label: 'Dusk',
    lightSeed: '#E5E8F0',
    darkSeed: '#20263A',
    defaultAccent: '#7DD3FC',
    mode: 'dark',
  },
  {
    id: 'charcoal',
    label: 'Charcoal',
    lightSeed: '#E7EAED',
    darkSeed: '#202225',
    defaultAccent: '#38BDF8',
    mode: 'dark',
  },
  {
    id: 'black',
    label: 'Black',
    lightSeed: '#EFF1F5',
    darkSeed: '#08090B',
    defaultAccent: '#60A5FA',
    mode: 'dark',
  },
]

export const backgroundOptions: BackgroundOption[] = [
  { value: -1, color: '#FFFFFF' },
  { value: 1, color: '#F4F6F7' },
  { value: -2, color: '#F3E8D2' },
  { value: -3, color: '#E1EED8' },
  { value: 3, color: '#DDE5EA' },
  { value: 5, color: '#D1DEE6' },
]

const legacyBackgroundPresetMap: Record<number, BackgroundPresetId> = {
  [-1]: 'clean',
  1: 'clean',
  [-2]: 'sepia',
  [-3]: 'sage',
  3: 'mist',
  5: 'mist',
  [customBackgroundValue]: 'custom',
}

const presetMap = new Map<BackgroundPresetId, BackgroundPreset>(backgroundPresets.map((preset) => [preset.id, preset]))

const flowShadcnBridge: [string, string][] = [
  ['--background', 'var(--flow-bg-content)'],
  ['--foreground', 'var(--flow-text)'],
  ['--card', 'var(--flow-bg-panel)'],
  ['--card-foreground', 'var(--flow-text)'],
  ['--popover', 'var(--flow-bg-panel)'],
  ['--popover-foreground', 'var(--flow-text)'],
  ['--primary', 'var(--flow-accent)'],
  ['--primary-foreground', 'var(--flow-accent-text)'],
  ['--secondary', 'var(--flow-bg-control)'],
  ['--secondary-foreground', 'var(--flow-text)'],
  ['--muted', 'var(--flow-bg-control-hover)'],
  ['--muted-foreground', 'var(--flow-text-muted)'],
  ['--accent', 'var(--flow-bg-control-hover)'],
  ['--accent-foreground', 'var(--flow-text)'],
  ['--destructive', 'var(--flow-danger)'],
  ['--destructive-foreground', 'var(--flow-danger-text)'],
  ['--border', 'var(--flow-border)'],
  ['--input', 'var(--flow-border)'],
  ['--ring', 'var(--flow-focus-ring)'],
  ['--chart-1', 'var(--flow-accent)'],
  ['--chart-2', 'var(--flow-accent-border)'],
  ['--chart-3', 'var(--flow-text-muted)'],
  ['--chart-4', 'var(--flow-danger)'],
  ['--chart-5', 'var(--flow-border-strong)'],
  ['--sidebar', 'var(--flow-bg-sidebar)'],
  ['--sidebar-foreground', 'var(--flow-text)'],
  ['--sidebar-primary', 'var(--flow-accent)'],
  ['--sidebar-primary-foreground', 'var(--flow-accent-text)'],
  ['--sidebar-accent', 'var(--flow-accent-bg)'],
  ['--sidebar-accent-foreground', 'var(--flow-text)'],
  ['--sidebar-border', 'var(--flow-border)'],
  ['--sidebar-ring', 'var(--flow-focus-ring)'],
]

function declarationsToCss(declarations: readonly [string, string][]) {
  return declarations.map(([property, value]) => `${property}:${value};`).join('')
}

export function normalizeThemeConfiguration(value: ThemeConfiguration | undefined): NormalizedThemeConfiguration {
  const legacyPreset = typeof value?.background === 'number' ? legacyBackgroundPresetMap[value.background] : undefined
  const requestedPreset = isBackgroundPresetId(value?.backgroundPreset) ? value.backgroundPreset : undefined
  const backgroundPreset = requestedPreset ?? legacyPreset ?? ('clean' as BackgroundPresetId)
  const customBackground = normalizePaletteColor(value?.customBackground)
  const preset = backgroundPreset === 'custom' ? undefined : presetMap.get(backgroundPreset)
  const accent = normalizePaletteColor(value?.accent ?? value?.source) ?? preset?.defaultAccent ?? defaultAccentColor
  const scheme = isFlowThemeScheme(value?.scheme) ? value.scheme : (preset?.mode ?? 'light')
  const contrast = value?.contrast === 'high' ? 'high' : 'standard'

  return {
    accent,
    backgroundPreset,
    ...(backgroundPreset === 'custom'
      ? {
          customBackground:
            customBackground ??
            (isDarkPaletteColor(value?.customBackground) ? darkBackgroundColor : defaultCustomBackgroundColor),
        }
      : {}),
    scheme,
    contrast,
  }
}

export function createFlowThemeTokens(configuration?: ThemeConfiguration, forcedScheme?: SchemeName): FlowThemeTokens {
  const normalized = normalizeThemeConfiguration(configuration)
  const preset = normalized.backgroundPreset === 'custom' ? undefined : presetMap.get(normalized.backgroundPreset)
  const scheme =
    forcedScheme ??
    (normalized.scheme === 'dark' || (normalized.scheme === 'system' && preset?.mode === 'dark') ? 'dark' : 'light')
  const seed =
    normalized.backgroundPreset === 'custom'
      ? (normalized.customBackground ?? defaultCustomBackgroundColor)
      : scheme === 'dark'
        ? preset?.darkSeed
        : preset?.lightSeed
  const accent = normalizePaletteColor(normalized.accent) ?? defaultAccentColor

  return scheme === 'dark'
    ? createDarkFlowThemeTokens(seed ?? darkBackgroundColor, accent, normalized.contrast)
    : createLightFlowThemeTokens(seed ?? '#FFFFFF', accent, normalized.contrast)
}

export function createFlowThemeCss(configuration?: ThemeConfiguration) {
  const lightTokens = createFlowThemeTokens(configuration, 'light')
  const darkTokens = createFlowThemeTokens(configuration, 'dark')

  return (
    `:root, .light {${declarationsToCss([
      ['color-scheme', 'light'],
      ...flowTokenDeclarations(lightTokens),
      ...flowCompatibilityDeclarations(lightTokens),
      ...flowShadcnBridge,
    ])}}` +
    `:root.dark {${declarationsToCss([
      ['color-scheme', 'dark'],
      ...flowTokenDeclarations(darkTokens),
      ...flowCompatibilityDeclarations(darkTokens),
      ...flowShadcnBridge,
    ])}}`
  )
}

function createLightFlowThemeTokens(seed: string, accent: string, contrast: FlowThemeContrast): FlowThemeTokens {
  const content = normalizePaletteColor(seed) ?? '#FFFFFF'
  const highContrast = contrast === 'high'
  const tabbar = ensureLayerContrast(
    mixHexColor(content, '#000000', highContrast ? 0.12 : 0.085),
    content,
    highContrast ? 1.16 : 1.08,
  )
  const tabActive = content
  const tabBorder = ensureMultiBackgroundContrast(
    mixHexColor(content, '#000000', highContrast ? 0.36 : 0.26),
    [tabbar, tabActive],
    highContrast ? 1.55 : 1.35,
  )
  const tabBorderStrong = ensureMultiBackgroundContrast(
    mixHexColor(content, '#000000', highContrast ? 0.48 : 0.36),
    [tabbar, tabActive],
    highContrast ? 1.8 : 1.55,
  )
  const text = ensureContrast(highContrast ? '#111827' : '#18212A', content, highContrast ? 7 : 4.5)
  const muted = ensureContrast(
    mixHexColor(content, '#000000', highContrast ? 0.62 : 0.52),
    content,
    highContrast ? 4.5 : 3,
  )
  const accentBg = mixHexColor(content, accent, highContrast ? 0.2 : 0.14)
  const sidebar = mixHexColor(content, '#000000', highContrast ? 0.1 : 0.07)
  const sidebarItem = createSurfaceItemTokens(sidebar, '#FFFFFF', highContrast)

  return {
    '--flow-bg-app': mixHexColor(content, '#000000', highContrast ? 0.07 : 0.04),
    '--flow-bg-activity': mixHexColor(content, '#000000', highContrast ? 0.16 : 0.12),
    '--flow-bg-sidebar': sidebar,
    '--flow-bg-content': content,
    '--flow-bg-tabbar': tabbar,
    '--flow-bg-tab-active': tabActive,
    '--flow-bg-panel': mixHexColor(content, '#FFFFFF', 0.44),
    '--flow-bg-control': mixHexColor(content, '#000000', highContrast ? 0.1 : 0.055),
    '--flow-bg-control-hover': mixHexColor(content, '#000000', highContrast ? 0.15 : 0.095),
    '--flow-bg-control-active': mixHexColor(content, '#000000', highContrast ? 0.2 : 0.14),
    '--flow-sidebar-item-bg': sidebarItem.bg,
    '--flow-sidebar-item-bg-hover': sidebarItem.hover,
    '--flow-sidebar-item-bg-active': sidebarItem.active,
    '--flow-sidebar-item-border': sidebarItem.border,
    '--flow-text': text,
    '--flow-text-muted': muted,
    '--flow-border': mixHexColor(content, '#000000', highContrast ? 0.24 : 0.16),
    '--flow-border-strong': mixHexColor(content, '#000000', highContrast ? 0.36 : 0.27),
    '--flow-tab-border': tabBorder,
    '--flow-tab-border-strong': tabBorderStrong,
    '--flow-accent': accent,
    '--flow-accent-text': readableTextForBackground(accent),
    '--flow-accent-bg': accentBg,
    '--flow-accent-bg-hover': mixHexColor(content, accent, highContrast ? 0.29 : 0.21),
    '--flow-accent-border': mixHexColor(content, accent, highContrast ? 0.58 : 0.42),
    '--flow-focus-ring': accent,
    '--flow-success': '#15803D',
    '--flow-warning': '#A16207',
    '--flow-danger': '#DC2626',
    '--flow-danger-bg': '#FEE2E2',
    '--flow-danger-bg-hover': '#FECACA',
    '--flow-danger-text': '#7F1D1D',
  }
}

function createDarkFlowThemeTokens(seed: string, accent: string, contrast: FlowThemeContrast): FlowThemeTokens {
  const content = normalizePaletteColor(seed) ?? darkBackgroundColor
  const highContrast = contrast === 'high'
  const tabbar = ensureLayerContrast(
    mixHexColor(content, '#FFFFFF', highContrast ? 0.16 : 0.095),
    content,
    highContrast ? 1.18 : 1.08,
  )
  const tabActive = content
  const tabBorder = ensureMultiBackgroundContrast(
    mixHexColor(content, '#FFFFFF', highContrast ? 0.42 : 0.31),
    [tabbar, tabActive],
    highContrast ? 1.55 : 1.35,
  )
  const tabBorderStrong = ensureMultiBackgroundContrast(
    mixHexColor(content, '#FFFFFF', highContrast ? 0.55 : 0.43),
    [tabbar, tabActive],
    highContrast ? 1.85 : 1.58,
  )
  const text = ensureContrast(highContrast ? '#FFFFFF' : '#EEF3F7', content, highContrast ? 7 : 4.5)
  const muted = ensureContrast(
    mixHexColor(content, '#FFFFFF', highContrast ? 0.7 : 0.58),
    content,
    highContrast ? 4.5 : 3,
  )
  const accentBg = mixHexColor(content, accent, highContrast ? 0.34 : 0.26)
  const sidebar = mixHexColor(content, '#FFFFFF', highContrast ? 0.08 : 0.055)
  const sidebarItem = createSurfaceItemTokens(sidebar, '#FFFFFF', highContrast)

  return {
    '--flow-bg-app': mixHexColor(content, '#000000', highContrast ? 0.42 : 0.3),
    '--flow-bg-activity': mixHexColor(content, '#000000', highContrast ? 0.25 : 0.16),
    '--flow-bg-sidebar': sidebar,
    '--flow-bg-content': content,
    '--flow-bg-tabbar': tabbar,
    '--flow-bg-tab-active': tabActive,
    '--flow-bg-panel': mixHexColor(content, '#FFFFFF', highContrast ? 0.1 : 0.075),
    '--flow-bg-control': mixHexColor(content, '#FFFFFF', highContrast ? 0.16 : 0.11),
    '--flow-bg-control-hover': mixHexColor(content, '#FFFFFF', highContrast ? 0.24 : 0.17),
    '--flow-bg-control-active': mixHexColor(content, '#FFFFFF', highContrast ? 0.31 : 0.23),
    '--flow-sidebar-item-bg': sidebarItem.bg,
    '--flow-sidebar-item-bg-hover': sidebarItem.hover,
    '--flow-sidebar-item-bg-active': sidebarItem.active,
    '--flow-sidebar-item-border': sidebarItem.border,
    '--flow-text': text,
    '--flow-text-muted': muted,
    '--flow-border': mixHexColor(content, '#FFFFFF', highContrast ? 0.28 : 0.18),
    '--flow-border-strong': mixHexColor(content, '#FFFFFF', highContrast ? 0.42 : 0.31),
    '--flow-tab-border': tabBorder,
    '--flow-tab-border-strong': tabBorderStrong,
    '--flow-accent': accent,
    '--flow-accent-text': readableTextForBackground(accent),
    '--flow-accent-bg': accentBg,
    '--flow-accent-bg-hover': mixHexColor(content, accent, highContrast ? 0.44 : 0.34),
    '--flow-accent-border': mixHexColor(content, accent, highContrast ? 0.66 : 0.52),
    '--flow-focus-ring': accent,
    '--flow-success': '#4ADE80',
    '--flow-warning': '#FACC15',
    '--flow-danger': '#F87171',
    '--flow-danger-bg': '#451A1A',
    '--flow-danger-bg-hover': '#5F1F23',
    '--flow-danger-text': '#FECACA',
  }
}

function flowTokenDeclarations(tokens: FlowThemeTokens): [string, string][] {
  return Object.entries(tokens) as [string, string][]
}

function flowCompatibilityDeclarations(tokens: FlowThemeTokens): [string, string][] {
  return [
    ['--flow-bg-active', tokens['--flow-accent-bg']],
    ['--flow-bg-active-hover', tokens['--flow-accent-bg-hover']],
    ['--flow-accent-solid-hover', mixHexColor(tokens['--flow-accent'], '#000000', 0.08)],
    ['--radius', '0.625rem'],
  ]
}

function createSurfaceItemTokens(surface: string, raisedColor: string, highContrast: boolean) {
  const darkSurface = relativeLuminance(surface) < 0.28
  const normalAmount = darkSurface ? (highContrast ? 0.14 : 0.08) : highContrast ? 0.28 : 0.22
  const hoverAmount = darkSurface ? (highContrast ? 0.2 : 0.13) : highContrast ? 0.38 : 0.3
  const activeAmount = darkSurface ? (highContrast ? 0.26 : 0.18) : highContrast ? 0.48 : 0.38
  const normal = ensureLayerContrastToward(
    mixHexColor(surface, raisedColor, normalAmount),
    surface,
    highContrast ? 1.22 : 1.12,
    raisedColor,
  )
  const hover = ensureLayerContrastToward(
    mixHexColor(surface, raisedColor, hoverAmount),
    surface,
    highContrast ? 1.32 : 1.2,
    raisedColor,
  )
  const active = ensureLayerContrastToward(
    mixHexColor(surface, raisedColor, activeAmount),
    surface,
    highContrast ? 1.44 : 1.3,
    raisedColor,
  )
  const borderBase = mixHexColor(
    normal,
    relativeLuminance(surface) > 0.5 ? '#000000' : '#FFFFFF',
    highContrast ? 0.24 : 0.16,
  )
  const border = ensureMultiBackgroundContrast(borderBase, [surface, normal, hover, active], highContrast ? 1.24 : 1.14)

  return {
    bg: normal,
    hover,
    active,
    border,
  }
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

  return rgbToHex(rgb.map((channel) => Math.round(channel * (1 - amount))) as RgbColor)
}

type RgbColor = [number, number, number]

function isBackgroundPresetId(value: ThemeConfiguration['backgroundPreset'] | undefined): value is BackgroundPresetId {
  return value === 'custom' || backgroundPresets.some((p) => p.id === value)
}

function isFlowThemeScheme(value: unknown): value is FlowThemeScheme {
  return value === 'light' || value === 'dark' || value === 'system'
}

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
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`
}

function mixHexColor(from: string, to: string, amount: number) {
  const fromRgb = hexToRgb(from)
  const toRgb = hexToRgb(to)
  if (!fromRgb || !toRgb) return from

  return rgbToHex(
    fromRgb.map((channel, index) => {
      const target = toRgb[index] ?? channel
      return channel + (target - channel) * clamp(amount, 0, 1)
    }) as RgbColor,
  )
}

function readableTextForBackground(background: string) {
  const darkText = '#082F49'
  const lightText = '#FFFFFF'
  return contrastRatio(darkText, background) >= contrastRatio(lightText, background) ? darkText : lightText
}

function ensureLayerContrast(color: string, background: string, target: number) {
  if (contrastRatio(color, background) >= target) return color

  const backgroundLuminance = relativeLuminance(background)
  const targetColor = backgroundLuminance > 0.5 ? '#000000' : '#FFFFFF'

  for (let amount = 0.08; amount <= 1; amount += 0.08) {
    const next = mixHexColor(color, targetColor, amount)
    if (contrastRatio(next, background) >= target) return next
  }

  return targetColor
}

function ensureLayerContrastToward(color: string, background: string, target: number, targetColor: string) {
  if (contrastRatio(color, background) >= target) return color

  for (let amount = 0.04; amount <= 1; amount += 0.04) {
    const next = mixHexColor(color, targetColor, amount)
    if (contrastRatio(next, background) >= target) return next
  }

  return targetColor
}

function ensureMultiBackgroundContrast(color: string, backgrounds: string[], target: number) {
  if (backgrounds.every((background) => contrastRatio(color, background) >= target)) {
    return color
  }

  const averageLuminance =
    backgrounds.reduce((sum, background) => sum + relativeLuminance(background), 0) / backgrounds.length
  const targetColor = averageLuminance > 0.5 ? '#000000' : '#FFFFFF'

  for (let amount = 0.08; amount <= 1; amount += 0.08) {
    const next = mixHexColor(color, targetColor, amount)
    if (backgrounds.every((background) => contrastRatio(next, background) >= target)) {
      return next
    }
  }

  return targetColor
}

function ensureContrast(color: string, background: string, target: number) {
  if (contrastRatio(color, background) >= target) return color

  const bgLuminance = relativeLuminance(background)
  const targetColor = bgLuminance > 0.5 ? '#000000' : '#FFFFFF'
  let next = color

  for (let amount = 0.08; amount <= 1; amount += 0.08) {
    next = mixHexColor(color, targetColor, amount)
    if (contrastRatio(next, background) >= target) return next
  }

  return targetColor
}

function relativeLuminance(color: string) {
  const rgb = hexToRgb(color)
  if (!rgb) return 0

  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }) as RgbColor

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string) {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b))
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function isDarkPaletteColor(color: string | undefined) {
  const rgb = color ? hexToRgb(color) : undefined
  if (!rgb) return false

  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }) as RgbColor

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance < 0.45
}
