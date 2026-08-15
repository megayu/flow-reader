import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as annotationModule from '../../src/annotation.ts'
import * as readerModelModule from '../../src/models/reader/model.ts'
import * as readerSearchModule from '../../src/models/reader/search.ts'
import { createTestBook } from '../support/book-fixtures.ts'

const annotation = annotationModule as Record<string, any>
const readerModel = readerModelModule as Record<string, any>
const readerSearch = readerSearchModule as Record<string, any>

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

function testSectionMatchesDoNotRequireNavItem() {
  const cfi = 'epubcfi(/6/8!/4/2/1:0)'
  const result = readerSearch.searchInSection(
    {
      getNavPath: () => {
        throw new Error('A section without a nav item must not request a nav path')
      },
    },
    'Technology',
    {
      document: { body: {} },
      find: (query: string) => {
        assert.strictEqual(query, 'Technology')
        return [{ cfi, excerpt: 'Technology' }]
      },
      href: 'Text/dedication.xhtml',
    },
  )

  assert.strictEqual(result?.id, 'Text/dedication.xhtml')
  assert.deepStrictEqual(result?.subitems, [{ cfi, excerpt: 'Technology', id: cfi }])
}

async function testDeepLinkWaitsForPendingPageTurn() {
  const cfi = 'epubcfi(/6/4!/4/2/1:0)'
  let finishPageTurn: (() => void) | undefined
  const pageTurn = new Promise<void>((resolve) => {
    finishPageTurn = resolve
  })
  const displays: string[] = []
  const tab = new readerModel.BookTab(createTestBook({ id: 'deep-link-navigation' }))
  tab.rendered = true
  tab.epub = {
    spine: {
      get: () => ({ href: 'chapter.xhtml', index: 0 }),
    },
  }
  tab.rendition = {
    display: async (target: string) => {
      displays.push(target)
    },
    next: () => pageTurn,
  }

  const turning = tab.next()
  tab.navigateFromDeepLink(cfi)
  await Promise.resolve()
  assert.deepStrictEqual(displays, [])

  finishPageTurn?.()
  await turning
  await tab.displayPendingDeepLinkTarget()
  assert.deepStrictEqual(displays, [cfi])
}

for (const run of [
  testAnnotationSpineDoesNotRequireNavItem,
  testChapterFindUsesTheReadingOrderStartSection,
  testDeepLinkWaitsForPendingPageTurn,
  testSectionMatchesDoNotRequireNavItem,
]) {
  test(run.name, run)
}
