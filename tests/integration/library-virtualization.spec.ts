import path from 'node:path'

import { expect, test } from '@playwright/test'

import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import { installTauriMock } from '../support/tauri-mock'

const bookCount = 240
const aliceEpubPath = path.resolve('packages/epubjs/test/fixtures/alice.epub')
const alicePackageUrl = '/test-assets/library-virtualization/alice.epub'

function createBook(index: number, titlePrefix = 'Virtual Book') {
  const number = String(index).padStart(3, '0')
  const title = `${titlePrefix} ${number}`

  return createTestBook({
    id: `virtual-book-${number}`,
    name: `${title}.epub`,
    size: 128000,
    metadata: {
      title,
      creator: 'Virtual Author',
      language: 'en',
    },
    createdAt: index,
    updatedAt: index,
    definitions: [],
    annotations: [],
  })
}

test('large libraries mount a bounded window while preserving far books and full-result selection', async ({
  page,
}) => {
  await installTauriMock(page, {
    books: Array.from({ length: bookCount }, (_, index) => createBook(index + 1)),
    settings: {
      libraryDisplay: { bookCardWidth: 160 },
      librarySort: { field: 'title', direction: 'asc' },
      showRecentBooks: false,
    },
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  const cards = page.locator('ul.grid [data-flow-library-book-card]')
  await expect(cards.first()).toContainText('Virtual Book 001')
  expect(await cards.count()).toBeLessThan(100)

  const libraryScroll = cards.first().locator('xpath=ancestor::*[@data-pane-scroll]')
  await libraryScroll.evaluate((scroll) => {
    scroll.scrollTop = scroll.scrollHeight
  })
  await expect(cards.filter({ hasText: 'Virtual Book 240' })).toBeVisible()
  expect(await cards.count()).toBeLessThan(100)

  await page.getByRole('button', { name: msg('home.select'), exact: true }).click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await expect(page.getByText(`${bookCount} / ${bookCount}`, { exact: true })).toBeVisible()
})

test('reader returns retain library search and restore short-return scroll position', async ({ page }) => {
  const books = Array.from({ length: bookCount }, (_, index) =>
    createBook(index + 1, index < bookCount / 2 ? 'Other Book' : 'Return Book'),
  )
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
      libraryDisplay: { bookCardWidth: 160 },
      librarySort: { field: 'title', direction: 'asc' },
      showRecentBooks: false,
    },
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  const cards = page.locator('ul.grid [data-flow-library-book-card]')
  const titleSearch = page.getByRole('textbox', { name: msg('home.library_search.title') })
  await titleSearch.fill('Return Book')
  await expect(cards.first()).toContainText('Return Book 121')
  await cards.first().click()
  await expect(page.locator('[data-flow-reader-content]')).toBeVisible()
  await page.clock.setSystemTime(Date.now() + 16_000)
  await page.keyboard.press('v')
  await expect(cards.first()).toBeVisible()
  await expect(titleSearch).toHaveValue('Return Book')

  const libraryScroll = cards.first().locator('xpath=ancestor::*[@data-pane-scroll]')
  const expectedScrollTop = await libraryScroll.evaluate((scroll) => {
    scroll.scrollTop = scroll.scrollHeight
    return scroll.scrollTop
  })
  expect(expectedScrollTop).toBeGreaterThan(0)
  await expect(cards.filter({ hasText: 'Return Book 240' })).toBeVisible()

  await page.keyboard.press('v')
  await expect(page.locator('[data-flow-reader-content]')).toBeVisible()
  await page.keyboard.press('v')
  await expect(titleSearch).toHaveValue('Return Book')
  await expect.poll(() => libraryScroll.evaluate((scroll) => scroll.scrollTop)).toBe(expectedScrollTop)
})

test('recent books retain prior entries while tracking is disabled', async ({ page }) => {
  const firstBook = createBook(1, 'Recent Reading A')
  const secondBook = createBook(2, 'Recent Reading B')
  await page.route(`**${alicePackageUrl}`, (route) =>
    route.fulfill({
      path: aliceEpubPath,
      contentType: 'application/epub+zip',
    }),
  )
  await installTauriMock(page, {
    books: [firstBook, secondBook],
    readerSources: {
      [firstBook.id]: alicePackageUrl,
      [secondBook.id]: alicePackageUrl,
    },
    settings: {
      libraryDisplay: { bookCardWidth: 200 },
      librarySort: { field: 'title', direction: 'asc' },
      showRecentBooks: false,
    },
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  await page.getByRole('button', { name: msg('home.bookshelf_view.title') }).click()
  await page.getByRole('checkbox', { name: msg('settings.show_recent_books') }).click()
  await page.keyboard.press('Escape')

  const libraryGrid = page.locator('ul[data-flow-library-grid]')
  await libraryGrid.locator('[data-flow-library-book-card]').filter({ hasText: 'Recent Reading A 001' }).click()
  await expect(page.locator('[data-flow-reader-content]:visible')).toBeVisible()
  await page.keyboard.press('v')
  const recentBooks = page.locator('[data-flow-library-recent-books]')
  await expect(recentBooks).toContainText('Recent Reading A 001')

  await page.getByRole('button', { name: msg('home.bookshelf_view.title') }).click()
  await page.getByRole('checkbox', { name: msg('settings.show_recent_books') }).click()
  await page.keyboard.press('Escape')
  await libraryGrid.locator('[data-flow-library-book-card]').filter({ hasText: 'Recent Reading B 002' }).click()
  await expect(page.locator('[data-flow-reader-content]:visible')).toBeVisible()
  await page.keyboard.press('v')

  await page.getByRole('button', { name: msg('home.bookshelf_view.title') }).click()
  await page.getByRole('checkbox', { name: msg('settings.show_recent_books') }).click()
  await page.keyboard.press('Escape')

  await expect(recentBooks).toContainText('Recent Reading A 001')
  await expect(recentBooks).not.toContainText('Recent Reading B 002')
})
