import assert from 'node:assert/strict'

import { test } from 'vitest'

import * as readerModelModule from '../../src/models/reader/model.ts'

const readerModel = readerModelModule as Record<string, any>

function testClosingBackgroundTabsPreservesTheSelectedTab() {
  const pages = ['A', 'B', 'C', 'D'].map((name) => {
    const Page = () => null
    Page.displayName = name
    return Page
  })
  const group = new readerModel.Group(pages, 2)
  const selectedTab = group.selectedTab

  group.removeTab(0)
  assert.strictEqual(group.selectedTab, selectedTab)

  group.removeTab(group.tabs.length - 1)
  assert.strictEqual(group.selectedTab, selectedTab)
}

test(testClosingBackgroundTabsPreservesTheSelectedTab.name, testClosingBackgroundTabsPreservesTheSelectedTab)
