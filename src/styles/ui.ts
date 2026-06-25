export const defaultUiFontSize = 15
export const minUiFontSize = 12
export const maxUiFontSize = 18

export function normalizeUiFontSize(value: number | undefined) {
  if (!Number.isFinite(value)) return defaultUiFontSize

  return Math.max(
    minUiFontSize,
    Math.min(maxUiFontSize, Math.round(value ?? defaultUiFontSize)),
  )
}

export function createAppTypographyCss(fontSize: number | undefined) {
  const base = normalizeUiFontSize(fontSize)
  const variables = {
    '--app-font-size-xs': `${Math.max(11, base - 2)}px`,
    '--app-font-size-sm': `${Math.max(12, base - 1)}px`,
    '--app-font-size-md': `${base}px`,
    '--app-font-size-lg': `${base + 2}px`,
    '--app-font-size-xl': `${base + 4}px`,
  }

  return `:root{${Object.entries(variables)
    .map(([property, value]) => `${property}:${value};`)
    .join('')}}`
}
