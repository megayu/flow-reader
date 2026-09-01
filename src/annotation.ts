export const annotationColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'brown'] as const

export type AnnotationColor = (typeof annotationColors)[number]

const annotationColorValues: Record<AnnotationColor, { red: number; green: number; blue: number; opacity: number }> = {
  red: { red: 225, green: 29, blue: 72, opacity: 0.36 },
  orange: { red: 234, green: 88, blue: 12, opacity: 0.42 },
  yellow: { red: 202, green: 138, blue: 4, opacity: 0.42 },
  green: { red: 22, green: 163, blue: 74, opacity: 0.38 },
  blue: { red: 37, green: 99, blue: 235, opacity: 0.34 },
  purple: { red: 126, green: 34, blue: 206, opacity: 0.36 },
  brown: { red: 120, green: 53, blue: 15, opacity: 0.46 },
}

export const annotationColorIcons: Record<AnnotationColor, string> = {
  red: '🔴',
  orange: '🟠',
  yellow: '🟡',
  green: '🟢',
  blue: '🔵',
  purple: '🟣',
  brown: '🟤',
}

export const colorMap = Object.fromEntries(
  annotationColors.map((color) => {
    const { red, green, blue, opacity } = annotationColorValues[color]
    return [color, `rgba(${red}, ${green}, ${blue}, ${opacity})`]
  }),
) as Record<AnnotationColor, string>

export const annotationOverlayOpacity = 0.4

export function annotationOverlayColor(color: AnnotationColor) {
  const { red, green, blue } = annotationColorValues[color]
  return `rgb(${red}, ${green}, ${blue})`
}

export function orderRangeRectsForWritingMode<T extends DOMRectReadOnly>(rects: readonly T[], writingMode: string) {
  if (writingMode !== 'vertical-rl') return [...rects]

  return [...rects].sort((a, b) => b.left - a.left || a.top - b.top)
}

export interface AnnotationSpine {
  index: number
  href: string
  title?: string
}

interface AnnotationSectionLike {
  index?: number
  href?: string
  navitem?: {
    label?: string
  }
}

export function createAnnotationSpine(section: AnnotationSectionLike | undefined): AnnotationSpine | undefined {
  if (!section || typeof section.index !== 'number' || typeof section.href !== 'string' || !section.href) {
    return
  }

  const title = section.navitem?.label?.trim()

  return {
    index: section.index,
    href: section.href,
    ...(title ? { title } : {}),
  }
}

export function getAnnotationSpineTitle(spine: AnnotationSpine) {
  return spine.title ?? spine.href ?? String(spine.index)
}

export interface Annotation {
  cfi: string
  spine: AnnotationSpine
  createdAt: number
  updatedAt: number
  color: AnnotationColor
  notes?: string
  text: string
}
