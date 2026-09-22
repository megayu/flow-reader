import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import * as readerModelModule from '../../src/models/reader/model.ts'
import { type BookModeSwitchResult, db } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures.ts'

const readerModel = readerModelModule as Record<string, any>

async function testClosingBackgroundTabsPreservesTheSelectedTab() {
  const books = ['A', 'B', 'C', 'D'].map((id) => createTestBook({ id, name: `${id}.epub` }))
  const reader = new readerModel.Reader()
  books.forEach((book) => reader.addTab(book))
  reader.selectTab(2)
  reader.tabs.forEach((tab: any) => {
    tab.destroy = async () => undefined
  })
  const selectedTab = reader.focusedBookTab

  await reader.removeTab(0)
  assert.strictEqual(reader.focusedBookTab, selectedTab)

  await reader.removeTab(reader.tabs.length - 1)
  assert.strictEqual(reader.focusedBookTab, selectedTab)
}

test(testClosingBackgroundTabsPreservesTheSelectedTab.name, testClosingBackgroundTabsPreservesTheSelectedTab)

test('reader close reports resource release failures after disposing the rendering', async () => {
  const reader = new readerModel.Reader()
  const tab = reader.addTab(createTestBook({ id: 'close-failure' }))
  tab.readerResourceOpen = true
  tab.flushForClose = async () => undefined
  let disposed = false
  tab.epub = {
    destroy: () => {
      disposed = true
    },
  }
  const failure = new Error('Resource release failed')
  const close = vi.spyOn(db.files, 'closeReader').mockRejectedValue(failure)
  try {
    await assert.rejects(reader.closeBookTab(tab.book.id), failure)
    assert.equal(disposed, true)
    assert.equal(reader.tabs.length, 0)
  } finally {
    close.mockRestore()
  }
})

test('mode switching blocks reopening until completion and releases the barrier after failures', async () => {
  for (const outcome of ['success', 'close-failure', 'switch-failure']) {
    const reader = new readerModel.Reader()
    const book = createTestBook({ id: 'switching', editable: true })
    const tab = reader.addTab(book)
    const closing = Promise.withResolvers<void>()
    const switching = Promise.withResolvers<BookModeSwitchResult>()
    const started = Promise.withResolvers<void>()
    const failure = new Error(outcome)
    let currentBook = book
    tab.destroy = () => closing.promise
    const get = vi.spyOn(db.books, 'get').mockImplementation(async () => currentBook)
    const close = vi.spyOn(db.files, 'closeReader').mockResolvedValue(undefined)
    const change = vi.spyOn(db.books, 'switchContentMode').mockImplementation(() => {
      started.resolve()
      return switching.promise
    })
    try {
      const operation = reader.switchBookContentMode(book.id, false, 'adopt')
      const result = outcome === 'success' ? operation : assert.rejects(operation, failure)
      const reopening = reader.addTab(book)
      await Promise.resolve()
      assert.equal(reader.tabs.length, 0)
      if (outcome === 'close-failure') {
        closing.reject(failure)
      } else {
        closing.resolve()
        await started.promise
        assert.equal(reader.tabs.length, 0)
        if (outcome === 'success') {
          currentBook = { ...book, editable: false }
          switching.resolve({ book: currentBook })
        } else {
          switching.reject(failure)
        }
      }
      await result
      const reopened = await reopening
      assert.equal(reopened.book.editable, currentBook.editable)
      assert.equal(reader.tabs.length, 1)
      if (outcome === 'close-failure') assert.equal(change.mock.calls.length, 0)
    } finally {
      get.mockRestore()
      close.mockRestore()
      change.mockRestore()
    }
  }
})
