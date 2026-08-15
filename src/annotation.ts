export const annotationColors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'brown'] as const

export type AnnotationColor = (typeof annotationColors)[number]

export const annotationColorIcons: Record<AnnotationColor, string> = {
  red: '🔴',
  orange: '🟠',
  yellow: '🟡',
  green: '🟢',
  blue: '🔵',
  purple: '🟣',
  brown: '🟤',
}

export const colorMap: Record<AnnotationColor, string> = {
  red: 'rgba(225, 29, 72, 0.36)',
  orange: 'rgba(234, 88, 12, 0.42)',
  yellow: 'rgba(202, 138, 4, 0.42)',
  green: 'rgba(22, 163, 74, 0.38)',
  blue: 'rgba(37, 99, 235, 0.34)',
  purple: 'rgba(126, 34, 206, 0.36)',
  brown: 'rgba(120, 53, 15, 0.46)',
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
