import { type Annotation, type AnnotationColor, annotationColors } from './annotation'

export type AnnotationNoteFilter = 'all' | 'with' | 'without'

export interface AnnotationFilterValue {
  colors: ReadonlySet<AnnotationColor>
  notes: AnnotationNoteFilter
}

export function createDefaultAnnotationFilter(): AnnotationFilterValue {
  return {
    colors: new Set(annotationColors),
    notes: 'all',
  }
}

export function isDefaultAnnotationFilter(filter: AnnotationFilterValue) {
  return filter.notes === 'all' && annotationColors.every((color) => filter.colors.has(color))
}

export function filterAnnotations(annotations: readonly Annotation[], filter: AnnotationFilterValue) {
  return annotations.filter((annotation) => {
    if (!filter.colors.has(annotation.color)) return false
    const hasNote = Boolean(annotation.notes?.trim())
    return filter.notes === 'all' || (filter.notes === 'with' ? hasNote : !hasNote)
  })
}
