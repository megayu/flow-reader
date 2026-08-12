import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { Location } from '@flow/epubjs'

import { calculateReadingPercentage } from '../../src/models/reader/pagination.ts'

function locationAtPage(page: number, percentage = 0): Location {
  const position = {
    cfi: 'epubcfi(/6/4!/4/2:0)',
    href: 'chapter-2.xhtml',
    index: 1,
    location: 0,
    percentage,
    displayed: { page, total: 10 },
  }

  return {
    atEnd: false,
    atStart: false,
    start: position,
    end: position,
  }
}

test('interpolates a section page within its persisted cumulative boundaries', () => {
  const readingMetrics = {
    version: 1,
    totalLength: 100,
    sections: [
      { href: 'chapter-1.xhtml', start: 0, end: 20 },
      { href: 'chapter-2.xhtml', start: 20, end: 80 },
      { href: 'chapter-3.xhtml', start: 80, end: 100 },
    ],
  }

  assert.strictEqual(calculateReadingPercentage({ location: locationAtPage(1), readingMetrics }), 0.2)
  assert.strictEqual(calculateReadingPercentage({ location: locationAtPage(6), readingMetrics }), 0.5)
})

test('falls back to whole-spine progress instead of the section percentage', () => {
  assert.strictEqual(calculateReadingPercentage({ location: locationAtPage(1, 1), sectionCount: 3 }), 1 / 3)
})

test('counts the current section as completed when each section is a page', () => {
  assert.strictEqual(
    calculateReadingPercentage({ location: locationAtPage(6), sectionCount: 3, sectionAsPage: true }),
    2 / 3,
  )
})
