import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as annotationModule from '../../src/annotation.ts'
import * as readerModelModule from '../../src/models/reader/model.ts'

const annotation = annotationModule as Record<string, any>
const readerModel = readerModelModule as Record<string, any>

function testAnnotationSpineDoesNotRequireNavItem() {
  assert.strictEqual(
    typeof annotation.createAnnotationSpine,
    'function',
    'Expected annotation spine creation to be independent of navitem',
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 3,
      href: 'Text/chapter-3.xhtml',
      navitem: { label: 'Chapter 3' },
    }),
    {
      index: 3,
      href: 'Text/chapter-3.xhtml',
      title: 'Chapter 3',
    },
  )

  assert.deepStrictEqual(
    annotation.createAnnotationSpine({
      index: 4,
      href: 'Text/chapter-4.xhtml',
    }),
    {
      index: 4,
      href: 'Text/chapter-4.xhtml',
    },
  )
}

function testChapterFindUsesTheReadingOrderStartSection() {
  assert.strictEqual(
    typeof readerModel.readingOrderStartSectionIndex,
    'function',
    'Expected chapter find to share the pagination-model reading order',
  )

  const spread = {
    left: { section: { index: 11 } },
    right: { section: { index: 12 } },
  }
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(spread, 'left-first', 20), 11)
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(spread, 'right-first', 20), 12)
  assert.strictEqual(readerModel.readingOrderStartSectionIndex(undefined, undefined, 20), 20)
}

for (const run of [testAnnotationSpineDoesNotRequireNavItem, testChapterFindUsesTheReadingOrderStartSection]) {
  test(run.name, run)
}
