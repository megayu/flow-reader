import assert from 'node:assert/strict'

import { test } from 'vitest'

import { RecentReadingModel } from '../../src/library/recentReading.ts'

function testRecentReadingRequiresAUserPositionChangeAfterOpen() {
  const recent = new RecentReadingModel(['older'])

  recent.beginSession('new-book')
  assert.equal(recent.observePosition('new-book', 'epubcfi(/6/2)', false), false)
  assert.equal(recent.observePosition('new-book', 'epubcfi(/6/2)', true), false)
  assert.deepEqual(recent.snapshot(), ['older'])

  assert.equal(recent.observePosition('new-book', 'epubcfi(/6/4)', false), false)
  assert.deepEqual(recent.snapshot(), ['older'])

  assert.equal(recent.observePosition('new-book', 'epubcfi(/6/6)', true), true)
  assert.deepEqual(recent.snapshot(), ['new-book', 'older'])

  recent.beginSession('older', 'epubcfi(/6/8)')
  assert.equal(recent.observePosition('older', 'epubcfi(/6/8)', true), false)
  assert.deepEqual(recent.snapshot(), ['new-book', 'older'])

  for (let index = 0; index < 11; index++) {
    const bookId = `book-${index}`
    recent.beginSession(bookId, 'epubcfi(/6/2)')
    recent.observePosition(bookId, 'epubcfi(/6/4)', true)
  }
  assert.deepEqual(recent.snapshot(), [
    'book-10',
    'book-9',
    'book-8',
    'book-7',
    'book-6',
    'book-5',
    'book-4',
    'book-3',
    'book-2',
    'book-1',
  ])
}

test(testRecentReadingRequiresAUserPositionChangeAfterOpen.name, testRecentReadingRequiresAUserPositionChangeAfterOpen)
