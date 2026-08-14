import path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import type { BookRecord } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import { installTauriMock } from '../support/tauri-mock'

const aliceEpubPath = path.resolve('packages/epubjs/test/fixtures/alice.epub')
const alicePackageUrl = '/test-assets/library-selection/alice.epub'

function createBook(index: number): BookRecord {
  const title = `Selection Book ${String(index).padStart(2, '0')}`

  return createTestBook({
    id: `selection-book-${index}`,
    name: `${title}.epub`,
    size: 128000,
    metadata: {
      title,
      creator: 'Selection Author',
      language: 'en',
    },
    createdAt: index,
    updatedAt: index,
    definitions: [],
    annotations: [],
  })
}

async function setupLibrary(page: Page, enterSelectionMode = true) {
  await installTauriMock(page, {
    books: Array.from({ length: 10 }, (_, index) => createBook(index + 1)),
    settings: {
      librarySort: { field: 'title', direction: 'asc' },
    },
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()
  await expect(bookCard(page, 1)).toBeVisible()
  if (enterSelectionMode) {
    await page.getByRole('button', { name: msg('home.select'), exact: true }).click()
  }
}

function bookCard(page: Page, index: number) {
  return page
    .locator('ul.grid [data-flow-library-book-card]')
    .filter({ hasText: `Selection Book ${String(index).padStart(2, '0')}` })
}

function selectedCount(page: Page) {
  return page.getByText(/^\d+ \/ 10$/)
}

async function expectSelectedCount(page: Page, count: number) {
  await expect(selectedCount(page)).toContainText(`${count} / 10`)
}

test('long pressing a cover enters selection mode without opening the book', async ({ page }) => {
  await setupLibrary(page, false)

  const cover = bookCard(page, 3).locator('img')
  const box = await cover.boundingBox()
  if (!box) throw new Error('Book cover has no bounding box')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expectSelectedCount(page, 1)
  await page.waitForTimeout(1100)
  await page.mouse.up()

  await expectSelectedCount(page, 1)
  await expect(page.locator('[data-flow-reader-tab-index]')).toHaveCount(0)
})

test('shift selection recomputes the active range until shift is released', async ({ page }) => {
  await setupLibrary(page)

  await bookCard(page, 5).click()
  await expectSelectedCount(page, 1)

  await page.keyboard.down('Shift')
  await bookCard(page, 10).click()
  await expectSelectedCount(page, 6)

  await bookCard(page, 5).click()
  await expectSelectedCount(page, 1)

  await bookCard(page, 1).click()
  await expectSelectedCount(page, 5)

  await page.keyboard.up('Shift')
  await page.keyboard.down('Shift')
  await bookCard(page, 10).click()
  await expectSelectedCount(page, 10)
  await page.keyboard.up('Shift')
})

test('mod click can set a new anchor before another shift range', async ({ page }) => {
  await setupLibrary(page)

  await bookCard(page, 1).click()
  await page.keyboard.down('Shift')
  await bookCard(page, 4).click()
  await page.keyboard.up('Shift')
  await expectSelectedCount(page, 4)

  await bookCard(page, 8).click({ modifiers: ['ControlOrMeta'] })
  await expectSelectedCount(page, 5)
  await bookCard(page, 10).click({ modifiers: ['ControlOrMeta', 'Shift'] })
  await expectSelectedCount(page, 7)
})

test('escape clears selection and exits selection mode before clearing filters', async ({ page }) => {
  await setupLibrary(page)

  await bookCard(page, 3).click()
  await expectSelectedCount(page, 1)

  const authorFilter = page.getByRole('button', { name: /^Selection Author$/ })
  await authorFilter.click()
  await expect(authorFilter).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expectSelectedCount(page, 0)
  await expect(page.getByRole('button', { name: msg('home.cancel'), exact: true })).toBeVisible()
  await expect(authorFilter).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: msg('home.select'), exact: true })).toBeVisible()
  await expect(selectedCount(page)).toHaveCount(0)
  await expect(authorFilter).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expect(authorFilter).toHaveAttribute('aria-pressed', 'false')
})

test('batch deletion closes selected open book tabs and preserves unselected tabs', async ({ page }) => {
  const books = [createBook(1), createBook(2), createBook(3)]
  await page.route(`**${alicePackageUrl}`, (route) =>
    route.fulfill({
      path: aliceEpubPath,
      contentType: 'application/epub+zip',
    }),
  )
  await installTauriMock(page, {
    books,
    readerSources: Object.fromEntries(books.map((book) => [book.id, alicePackageUrl])),
    settings: {
      librarySort: { field: 'title', direction: 'asc' },
    },
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  await bookCard(page, 1).click()
  await expect(page.locator('[data-flow-reader-tab-index]')).toHaveCount(1)
  await page.getByRole('button', { name: msg('mode.back_to_library') }).click()
  await bookCard(page, 2).click()
  await expect(page.locator('[data-flow-reader-tab-index]')).toHaveCount(2)
  await page.getByRole('button', { name: msg('mode.back_to_library') }).click()

  await page.getByRole('button', { name: msg('home.select'), exact: true }).click()
  await bookCard(page, 1).click()
  await bookCard(page, 3).click()
  await page.getByRole('button', { name: msg('home.delete'), exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: msg('home.delete'), exact: true })
    .click()

  await expect(page.locator('[data-flow-reader-tab-index]')).toHaveCount(1)
  await expect(page.locator('[data-flow-reader-tab-index]')).toContainText('Selection Book 02')
})
