import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as readerModelModule from '../../src/models/reader/model.ts'
import { createTestBook } from '../support/book-fixtures.ts'

const readerModel = readerModelModule as Record<string, any>

function testClosingBackgroundTabsPreservesTheSelectedTab() {
  const books = ['A', 'B', 'C', 'D'].map((id) => createTestBook({ id, name: `${id}.epub` }))
  const group = new readerModel.Group(books, 2)
  const selectedTab = group.selectedTab

  group.removeTab(0)
  assert.strictEqual(group.selectedTab, selectedTab)

  group.removeTab(group.tabs.length - 1)
  assert.strictEqual(group.selectedTab, selectedTab)
}

test(testClosingBackgroundTabsPreservesTheSelectedTab.name, testClosingBackgroundTabsPreservesTheSelectedTab)
