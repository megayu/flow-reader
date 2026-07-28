import path from 'node:path'

import { expect, test } from '@playwright/test'

import type { BookRecord } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { getStoredSettings, installTauriMock } from '../support/tauri-mock'

const pendingEpubPath = path.join('temporary', 'requested.epub')

function createBook(id: string, title: string): BookRecord {
  return createTestBook({
    id,
    name: `${title}.epub`,
    size: 1,
    metadata: { title },
    createdAt: 1,
    updatedAt: 1,
    definitions: [],
    annotations: [],
    stateLoaded: true,
  })
}

test('cold native EPUB request suppresses startup restore even when opening fails', async ({
  page,
}) => {
  const restored = createBook('restored-book', 'Restored Book')
  await installTauriMock(page, {
    books: [restored],
    pendingOpenPaths: [pendingEpubPath],
    settings: {
      restoreLastReadingOnStartup: true,
      startupSession: { viewMode: 'reader', bookId: restored.id },
    },
  })

  await page.goto('/')
  await page.waitForTimeout(1000)

  expect(
    await page.evaluate(() =>
      (window as any).reader.groups.flatMap((group: any) =>
        group.bookTabs.map((tab: any) => tab.book.id),
      ),
    ),
  ).toEqual([])
})

test('cold native EPUB open opens only the requested book', async ({
  page,
}) => {
  const restored = createBook('restored-book', 'Restored Book')
  const requested = createBook('requested-book', 'Requested Book')
  await installTauriMock(page, {
    books: [restored, requested],
    deferReaderSource: true,
    externallyOpenedBooks: [requested],
    pendingOpenPaths: [pendingEpubPath],
    settings: {
      readerSidebarOpen: true,
      restoreLastReadingOnStartup: true,
      startupSession: { viewMode: 'reader', bookId: restored.id },
    },
  })

  await page.goto('/')

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).reader.groups.flatMap((group: any) =>
          group.bookTabs.map((tab: any) => tab.book.id),
        ),
      ),
    )
    .toEqual([requested.id])
  await expect(page.getByTestId('native-startup-surface')).toBeVisible()
  await expect(page.locator('[role="tab"]')).toHaveCount(1)
  await page.evaluate(() => {
    ;(window as any).reader.focusedBookTab.rendered = true
  })
  await expect(page.getByTestId('native-startup-surface')).toHaveCount(0)
  await expect(page.locator('[role="tab"]')).toHaveCount(1)
  expect(
    await page.evaluate(
      () => (window as any).__FLOW_TEST_TAURI__?.takePendingOpenPathsCalls,
    ),
  ).toBe(1)
  await expect
    .poll(async () => (await getStoredSettings(page)).readerSidebarOpen)
    .toBe(true)
})

test('native EPUB open focuses an existing tab across reader groups', async ({
  page,
}) => {
  await installTauriMock(page)
  await page.goto('/')

  const result = await page.evaluate(() => {
    const reader = (window as any).reader
    const first = createBrowserBook('first-book', 'First Book')
    const second = createBrowserBook('second-book', 'Second Book')
    reader.clear()
    reader.addTab(first)
    reader.addGroup([second])
    reader.openBookTab(first)

    return {
      focusedBookId: reader.focusedBookTab?.book.id,
      focusedIndex: reader.focusedIndex,
      groupCount: reader.groups.length,
      firstBookTabCount: reader.groups
        .flatMap((group: any) => group.bookTabs)
        .filter((tab: any) => tab.book.id === first.id).length,
    }

    function createBrowserBook(id: string, title: string) {
      return {
        id,
        name: `${title}.epub`,
        size: 1,
        metadata: {
          title,
          creator: '',
          description: '',
          pubdate: '',
          publisher: '',
          identifier: id,
          language: '',
          rights: '',
          modified_date: '',
          layout: '',
          orientation: '',
          flow: '',
          viewport: '',
          spread: '',
        },
        createdAt: 1,
        updatedAt: 1,
        definitions: [],
        annotations: [],
        stateLoaded: true,
      }
    }
  })

  expect(result).toEqual({
    focusedBookId: 'first-book',
    focusedIndex: 0,
    groupCount: 2,
    firstBookTabCount: 1,
  })
})
