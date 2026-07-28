export function getRenditionPageWidth(rendition: unknown) {
  const pageWidth = (rendition as any)?.manager?.layout?.pageWidth
  return Number.isFinite(pageWidth) && pageWidth > 0
    ? Number(pageWidth)
    : undefined
}

export function getRenditionLayout(rendition: unknown) {
  return (rendition as any)?.manager?.layout
}

export function getFiniteLayoutValue(value: unknown, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback
}

export function getCurrentReaderPageWidth(
  rendition: unknown,
  container?: HTMLElement | null,
) {
  const pageWidth = getRenditionPageWidth(rendition)
  if (pageWidth) return Math.round(pageWidth)

  const rect = container?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return

  const divisor = getRenditionDivisor(rendition)
  return Math.round(rect.width / divisor)
}

export function getCurrentReaderSpreadWidth(
  rendition: unknown,
  container?: HTMLElement | null,
) {
  const pageWidth = getRenditionPageWidth(rendition)
  const rect = container?.getBoundingClientRect()
  if (!pageWidth) return rect?.width ? Math.round(rect.width) : undefined

  const divisor = getRenditionDivisor(rendition)
  const spreadWidth = Math.round(pageWidth * divisor)
  if (!rect || rect.width <= 0) return spreadWidth

  return Math.min(Math.round(rect.width), spreadWidth)
}

export function getRenditionDivisor(rendition: unknown) {
  const divisor = (rendition as any)?.manager?.layout?.divisor
  return Number.isFinite(divisor) && divisor > 1 ? Number(divisor) : 1
}
