import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as readerModelModule from '../../src/models/reader/model.ts'
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
