export type AnnotationType = keyof typeof typeMap

export const typeMap = {
  highlight: {
    style: 'backgroundColor',
    class: 'rounded',
  },
}

export const annotationColors = ['yellow', 'brown', 'red', 'green', 'cyan', 'blue', 'purple'] as const

export type AnnotationColor = (typeof annotationColors)[number]

export const annotationColorIcons: Record<AnnotationColor, string> = {
  yellow: '🟡',
  brown: '🟤',
  red: '🔴',
  green: '🟢',
  cyan: '🟠',
  blue: '🔵',
  purple: '🟣',
}

// Keep the stored color keys stable; tune the rendered fills for readability
// across both light and dark reader backgrounds.
export const colorMap: Record<AnnotationColor, string> = {
  yellow: 'rgba(202, 138, 4, 0.42)',
  brown: 'rgba(120, 53, 15, 0.46)',
  red: 'rgba(225, 29, 72, 0.36)',
  green: 'rgba(22, 163, 74, 0.38)',
  cyan: 'rgba(6, 182, 212, 0.46)',
  blue: 'rgba(37, 99, 235, 0.34)',
  purple: 'rgba(126, 34, 206, 0.36)',
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
  type: AnnotationType
  color: AnnotationColor
  notes?: string
  text: string
}
