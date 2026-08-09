function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readRenditionLayout(rendition: unknown) {
  if (!isPropertyBag(rendition) || !isPropertyBag(rendition.manager)) return

  const { layout } = rendition.manager
  return isPropertyBag(layout) ? layout : undefined
}

export function getRenditionPageWidth(rendition: unknown) {
  const pageWidth = readRenditionLayout(rendition)?.pageWidth
  return typeof pageWidth === 'number' && Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : undefined
}

export function getFiniteLayoutValue(value: unknown, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback
}

export function getCurrentReaderPageWidth(rendition: unknown, container?: HTMLElement | null) {
  const pageWidth = getRenditionPageWidth(rendition)
  if (pageWidth) return Math.round(pageWidth)

  const rect = container?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return

  const divisor = getRenditionDivisor(rendition)
  return Math.round(rect.width / divisor)
}

export function getCurrentReaderSpreadWidth(rendition: unknown, container?: HTMLElement | null) {
  const pageWidth = getRenditionPageWidth(rendition)
  const rect = container?.getBoundingClientRect()
  if (!pageWidth) return rect?.width ? Math.round(rect.width) : undefined

  const divisor = getRenditionDivisor(rendition)
  const spreadWidth = Math.round(pageWidth * divisor)
  if (!rect || rect.width <= 0) return spreadWidth

  return Math.min(Math.round(rect.width), spreadWidth)
}

export function getRenditionDivisor(rendition: unknown) {
  const divisor = readRenditionLayout(rendition)?.divisor
  return typeof divisor === 'number' && Number.isFinite(divisor) && divisor > 1 ? divisor : 1
}
