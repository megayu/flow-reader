export type AnnotationType = keyof typeof typeMap

export const typeMap = {
  highlight: {
    style: 'backgroundColor',
    class: 'rounded',
  },
  // underline: {
  //   style: 'border-bottom-color',
  //   class: 'border-b-2',
  // },
}

export type AnnotationColor = keyof typeof colorMap

// "dark color + low opacity" is clearer than "light color + high opacity"
// from tailwind [color]-600
export const colorMap = {
  yellow: 'rgba(217, 119, 6, 0.2)',
  red: 'rgba(220, 38, 38, 0.2)',
  green: 'rgba(22, 163, 74, 0.2)',
  blue: 'rgba(37, 99, 235, 0.2)',
}

export function normalizeDefinition(definition: string) {
  return definition.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function definitionComparisonKey(definition: string) {
  return normalizeDefinition(definition).toLowerCase()
}

export function compareDefinition(a: string, b: string) {
  const keyA = definitionComparisonKey(a)
  const keyB = definitionComparisonKey(b)
  return !!keyA && keyA === keyB
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

export function createAnnotationSpine(
  section: AnnotationSectionLike | undefined,
): AnnotationSpine | undefined {
  if (
    !section ||
    typeof section.index !== 'number' ||
    typeof section.href !== 'string' ||
    !section.href
  ) {
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
  id: string
  bookId: string
  cfi: string
  spine: AnnotationSpine
  createAt: number
  updatedAt: number
  type: AnnotationType
  color: AnnotationColor
  notes?: string
  text: string
}
