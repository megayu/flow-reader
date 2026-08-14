import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Annotation } from '../../src/annotation.ts'
import { AnnotationChanges } from '../../src/models/reader/annotationChanges.ts'

function annotation(cfi: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    cfi,
    spine: { index: 0, href: 'chapter.xhtml' },
    createdAt: 1,
    updatedAt: 1,
    type: 'highlight',
    color: 'yellow',
    text: cfi,
    ...overrides,
  }
}

test('tracks net annotation entities relative to the last checkpoint', () => {
  const persisted = annotation('persisted', { notes: 'saved note' })
  const changes = new AnnotationChanges([persisted])

  const added = annotation('added')
  changes.record(added.cfi, added)
  assert.equal(changes.size, 1)
  changes.record(added.cfi, undefined)
  assert.equal(changes.size, 0)

  changes.record(persisted.cfi, { ...persisted, color: 'blue', updatedAt: 2 })
  changes.record(persisted.cfi, { ...persisted, color: 'green', updatedAt: 3 })
  assert.equal(changes.size, 1)
  changes.record(persisted.cfi, { ...persisted, createdAt: 9, updatedAt: 9 })
  assert.equal(changes.size, 0)

  changes.record(persisted.cfi, undefined)
  assert.equal(changes.size, 1)
})
