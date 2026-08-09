import assert from 'node:assert/strict'

import { test } from 'vitest'

import { sortBooks } from '../../src/library/model.ts'
import { createTestBook } from '../support/book-fixtures.ts'

test('last-read sorting keeps unread books last and preserves source order for ties', () => {
  const books = [
    createTestBook({ id: 'unread-z', metadata: { title: 'Zeta' } }),
    createTestBook({ id: 'read-new', lastReadAt: 300, metadata: { title: 'Beta' } }),
    createTestBook({ id: 'unread-a', metadata: { title: 'Alpha' } }),
    createTestBook({ id: 'read-old', lastReadAt: 100, metadata: { title: 'Gamma' } }),
  ]

  assert.deepEqual(
    sortBooks(books, 'updatedAt', 'asc').map((book) => book.id),
    ['read-old', 'read-new', 'unread-z', 'unread-a'],
  )
  assert.deepEqual(
    sortBooks(books, 'updatedAt', 'desc').map((book) => book.id),
    ['read-new', 'read-old', 'unread-z', 'unread-a'],
  )
})
