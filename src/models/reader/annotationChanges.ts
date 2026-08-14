import type { Annotation } from '../../annotation'

interface SemanticAnnotation {
  cfi: string
  spineIndex: number
  spineHref: string
  spineTitle?: string
  type: Annotation['type']
  color: Annotation['color']
  notes?: string
  text: string
}

export function normalizedAnnotationNotes(annotation: Annotation | undefined) {
  return annotation?.notes?.trim() ? annotation.notes : undefined
}

function semanticAnnotation(annotation: Annotation): SemanticAnnotation {
  const notes = normalizedAnnotationNotes(annotation)
  return {
    cfi: annotation.cfi,
    spineIndex: annotation.spine.index,
    spineHref: annotation.spine.href,
    spineTitle: annotation.spine.title,
    type: annotation.type,
    color: annotation.color,
    notes,
    text: annotation.text,
  }
}

function sameAnnotation(left: SemanticAnnotation | undefined, right: SemanticAnnotation | undefined) {
  if (!left || !right) return left === right
  return (
    left.cfi === right.cfi &&
    left.spineIndex === right.spineIndex &&
    left.spineHref === right.spineHref &&
    left.spineTitle === right.spineTitle &&
    left.type === right.type &&
    left.color === right.color &&
    left.notes === right.notes &&
    left.text === right.text
  )
}

export function sameSemanticAnnotation(left: Annotation | undefined, right: Annotation | undefined) {
  return sameAnnotation(left ? semanticAnnotation(left) : undefined, right ? semanticAnnotation(right) : undefined)
}

function annotationMap(annotations: readonly Annotation[]) {
  return new Map(annotations.map((annotation) => [annotation.cfi, semanticAnnotation(annotation)]))
}

export class AnnotationChanges {
  private baseline: Map<string, SemanticAnnotation>
  private readonly changedIds = new Set<string>()

  constructor(annotations: readonly Annotation[]) {
    this.baseline = annotationMap(annotations)
  }

  get size() {
    return this.changedIds.size
  }

  record(id: string, annotation: Annotation | undefined) {
    const current = annotation ? semanticAnnotation(annotation) : undefined
    if (sameAnnotation(this.baseline.get(id), current)) {
      this.changedIds.delete(id)
    } else {
      this.changedIds.add(id)
    }
  }

  replaceBaseline(captured: readonly Annotation[], current: readonly Annotation[]) {
    this.baseline = annotationMap(captured)
    this.changedIds.clear()

    const currentIds = new Set<string>()
    for (const annotation of current) {
      currentIds.add(annotation.cfi)
      this.record(annotation.cfi, annotation)
    }
    for (const id of this.baseline.keys()) {
      if (!currentIds.has(id)) this.changedIds.add(id)
    }
  }
}
