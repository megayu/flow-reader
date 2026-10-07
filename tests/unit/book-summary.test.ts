import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import type { BookRecord } from '../../src/storage/types'
import { createTestBook } from '../support/book-fixtures'

const native = vi.hoisted(() => ({ invokeStorage: vi.fn() }))
vi.mock('../../src/storage/native', () => native)

test('repairs the cached reading summary without replacing newer local progress', async () => {
  const { db } = await import('../../src/storage/client')
  const previous = createTestBook({ cfi: 'old-position', percentage: 0.2, updatedAt: 50, lastReadAt: 60 })
  native.invokeStorage.mockResolvedValueOnce([previous])
  await db.books.toArray()
  const saved = { ...previous, cfi: 'saved-position', percentage: 0.8, updatedAt: 100, lastReadAt: 200 }
  native.invokeStorage.mockResolvedValueOnce(saved)
  await db.books.get(previous.id)
  assert.equal(db.books.peek(previous.id)?.cfi, saved.cfi)
  assert.equal(db.books.peek(previous.id)?.percentage, saved.percentage)
  assert.equal(db.books.peek(previous.id)?.updatedAt, saved.updatedAt)
  assert.equal(db.books.peek(previous.id)?.lastReadAt, saved.lastReadAt)

  const pending = Promise.withResolvers<BookRecord>()
  native.invokeStorage.mockReturnValueOnce(pending.promise)
  const reading = db.books.get(previous.id)
  db.books.updateCachedFields(previous.id, { cfi: 'current-position', percentage: 0.9, lastReadAt: 300 })
  pending.resolve(saved)
  await reading
  assert.equal(db.books.peek(previous.id)?.cfi, 'current-position')
  assert.equal(db.books.peek(previous.id)?.percentage, 0.9)
  assert.equal(db.books.peek(previous.id)?.lastReadAt, 300)

  native.invokeStorage.mockResolvedValueOnce(saved)
  await db.books.get(previous.id)
  assert.equal(db.books.peek(previous.id)?.cfi, 'current-position')
  assert.equal(db.books.peek(previous.id)?.lastReadAt, 300)
})
