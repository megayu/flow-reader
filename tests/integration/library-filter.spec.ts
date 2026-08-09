import path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import type { BookRecord, ReadingStatus } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import { getStoredLibraryPins, installTauriMock } from '../support/tauri-mock'

const longAuthor = 'Beatrice Longname With An Extraordinarily Extended Family Name That Should Ellipsize'
const authorSearchShortcut = process.platform === 'darwin' ? 'Meta+E' : 'Control+E'
const tagSearchShortcut = process.platform === 'darwin' ? 'Meta+T' : 'Control+T'

function createBook({
  creator,
  id,
  readingStatus,
  title,
}: {
  creator: string
  id: string
  readingStatus?: ReadingStatus
  title: string
}): BookRecord {
  return createTestBook({
    id,
    name: `${title}.epub`,
    size: 128000,
    readingStatus,
    metadata: {
      title,
      creator,
      language: 'en',
    },
    createdAt: 1,
    updatedAt: 1,
    definitions: [],
    annotations: [],
    stateLoaded: true,
  })
}

const fixtureBooks = [
  createBook({
    id: 'alpha',
    title: 'Alpha Draft',
    creator: 'Anne Able',
    readingStatus: 'toRead',
  }),
  createBook({
    id: 'beta',
    title: 'Beta Read',
    creator: longAuthor,
    readingStatus: 'read',
  }),
  createBook({
    id: 'gamma',
    title: 'Gamma Read',
    creator: 'Anne Able',
    readingStatus: 'read',
  }),
  createBook({
    id: 'no-author',
    title: 'No Author Book',
    creator: '',
    readingStatus: 'reading',
  }),
  createBook({
    id: 'clara',
    title: 'Clara Reading',
    creator: 'Clara Cove',
    readingStatus: 'reading',
  }),
]

const importedBooks = [
  createBook({
    id: 'delta',
    title: 'Delta Read',
    creator: 'Dorian Delta',
    readingStatus: 'read',
  }),
]

async function setupLibrary(page: Page) {
  await installTauriMock(page, {
    books: fixtureBooks,
    importedBooks,
    openDialogPaths: [path.join('books', 'delta.epub')],
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  await openLibraryFilterPanel(page)
}

async function openLibraryFilterPanel(page: Page) {
  const panel = page.getByTestId('library-filter-panel')

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await panel.isVisible()) return

    await page.getByRole('button', { name: msg('home.library_filter.title') }).click()
    await page.waitForTimeout(100)
  }

  await expect(panel).toBeVisible()
}

function authorChip(page: Page, author: string) {
  return page.getByTestId('library-author-chip').filter({ hasText: author })
}

async function authorNames(page: Page) {
  return page.getByTestId('library-author-chip-label').allTextContents()
}

async function pinnedAuthors(page: Page) {
  return (await getStoredLibraryPins(page)).authors
}

test('library author filters pin authors and refresh when books change', async ({ page }) => {
  await setupLibrary(page)

  const nativeContextMenuPrevented = await page.evaluate(() => {
    const target = document.querySelector('#layout')
    if (!target) return false

    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    })
    target.dispatchEvent(event)

    return event.defaultPrevented
  })

  expect(nativeContextMenuPrevented).toBe(true)

  await expect(authorChip(page, 'Anne Able')).toBeVisible()
  await expect(authorChip(page, longAuthor)).toBeVisible()
  await expect(authorChip(page, 'Clara Cove')).toBeVisible()
  await expect(authorChip(page, 'No Author Book')).toHaveCount(0)

  const longChipMetrics = await authorChip(page, longAuthor).evaluate((chip) => {
    const label = chip.querySelector('[data-testid="library-author-chip-label"]') as HTMLElement
    const panel = document.querySelector('[data-testid="library-filter-panel"]') as HTMLElement
    const labelStyle = getComputedStyle(label)

    return {
      chipWidth: Math.round(chip.getBoundingClientRect().width),
      labelOverflow: labelStyle.overflow,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      textOverflow: labelStyle.textOverflow,
      whiteSpace: labelStyle.whiteSpace,
    }
  })

  expect(longChipMetrics.chipWidth).toBeLessThanOrEqual(longChipMetrics.panelWidth)
  expect(longChipMetrics.labelOverflow).toBe('hidden')
  expect(longChipMetrics.textOverflow).toBe('ellipsis')
  expect(longChipMetrics.whiteSpace).toBe('nowrap')
  await expect(authorChip(page, longAuthor)).toHaveAttribute('title', longAuthor)
  await expect(authorChip(page, 'Anne Able')).not.toHaveAttribute('title', /.+/)

  await authorChip(page, 'Anne Able').click()
  await expect(page.getByText('Alpha Draft')).toBeVisible()
  await expect(page.getByText('Gamma Read')).toBeVisible()
  await expect(page.getByText('Beta Read')).toHaveCount(0)

  await page.getByTestId('library-filter-status-read').click()
  await expect(page.getByText('Alpha Draft')).toHaveCount(0)
  await expect(page.getByText('Gamma Read')).toBeVisible()

  await page
    .getByTestId('library-author-section')
    .getByRole('button', { name: msg('home.library_filter.reset') })
    .click()
  await expect(page.getByText('Beta Read')).toBeVisible()
  await expect(page.getByText('Gamma Read')).toBeVisible()

  await authorChip(page, longAuthor).click({ button: 'right' })
  await expect(
    page.getByTestId('library-author-context-menu').getByRole('menuitem', {
      name: msg('home.library_filter.pin_author'),
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByTestId('library-author-context-menu').getByRole('menuitem', {
      name: msg('home.library_filter.unpin_author'),
      exact: true,
    }),
  ).toHaveCount(0)
  await page
    .getByTestId('library-author-context-menu')
    .getByRole('menuitem', { name: msg('home.library_filter.pin_author'), exact: true })
    .click()
  await expect.poll(() => authorNames(page)).toEqual([longAuthor, 'Anne Able'])
  await expect.poll(() => pinnedAuthors(page)).toEqual([longAuthor])

  await authorChip(page, 'Anne Able').click({ button: 'right' })
  await page
    .getByTestId('library-author-context-menu')
    .getByRole('menuitem', { name: msg('home.library_filter.pin_author'), exact: true })
    .click()
  await expect.poll(() => authorNames(page)).toEqual(['Anne Able', longAuthor])
  await expect.poll(() => pinnedAuthors(page)).toEqual(['Anne Able', longAuthor])

  await authorChip(page, 'Anne Able').click({ button: 'right' })
  await expect(
    page.getByTestId('library-author-context-menu').getByRole('menuitem', {
      name: msg('home.library_filter.pin_author'),
      exact: true,
    }),
  ).toBeVisible()
  await page
    .getByTestId('library-author-context-menu')
    .getByRole('menuitem', { name: msg('home.library_filter.unpin_author'), exact: true })
    .click()
  await expect.poll(() => authorNames(page)).toEqual([longAuthor, 'Anne Able'])
  await expect.poll(() => pinnedAuthors(page)).toEqual([longAuthor])

  await page
    .locator('ul.grid [data-flow-library-book-card]')
    .filter({ hasText: 'Beta Read' })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.context.delete') }).click()
  await page.getByRole('menuitem', { name: msg('home.context.confirm_delete') }).click()
  await expect(page.getByText('Beta Read')).toHaveCount(0)
  await expect(authorChip(page, longAuthor)).toHaveCount(0)
  await expect.poll(() => pinnedAuthors(page)).toEqual([])

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.import_books') }).click()
  await expect(page.getByText('Delta Read')).toBeVisible()
  await expect(authorChip(page, 'Dorian Delta')).toBeVisible()

  await page.reload()
  await expect(page.locator('#layout')).toBeVisible()
  await openLibraryFilterPanel(page)
  await expect.poll(() => pinnedAuthors(page)).toEqual([])
  await expect.poll(() => authorNames(page)).toContainEqual(longAuthor)
  expect((await authorNames(page))[0]).toBe('Anne Able')
})

test('library filter panel clears filters on Escape without closing', async ({ page }) => {
  await setupLibrary(page)

  await authorChip(page, 'Anne Able').click()
  await expect(page.getByText('Alpha Draft')).toBeVisible()
  await expect(page.getByText('Gamma Read')).toBeVisible()
  await expect(page.getByText('Beta Read')).toHaveCount(0)

  await page.getByRole('button', { name: msg('home.library_filter.clear'), exact: true }).hover()
  await expect(page.getByRole('tooltip').locator('kbd')).toContainText(['Esc'])
  await page.mouse.move(500, 500)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-filter-panel')).toBeVisible()
  await expect(authorChip(page, 'Anne Able')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('Beta Read')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-filter-panel')).toBeVisible()
})

test('library facet searches stay scoped and exit on blur without clearing applied filters', async ({ page }) => {
  await installTauriMock(page, {
    books: fixtureBooks.map((book, index) => ({
      ...book,
      tagIds: [index % 2 ? 'tag-notes' : 'tag-reference'],
    })),
    tags: [
      { id: 'tag-notes', name: 'Notes', createdAt: 1 },
      { id: 'tag-reference', name: 'Reference', createdAt: 2 },
    ],
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()
  await openLibraryFilterPanel(page)

  await page.keyboard.press(authorSearchShortcut)
  const authorSearch = page.getByRole('textbox', { name: msg('home.library_filter.search_authors') })
  await expect(authorSearch).toBeFocused()
  await authorSearch.fill('ABLE')
  await expect(authorChip(page, 'Anne Able')).toBeVisible()
  await expect(authorChip(page, 'Clara Cove')).toHaveCount(0)
  await expect(page.getByTestId('library-tag-chip')).toHaveCount(2)

  await authorChip(page, 'Anne Able').click()
  await expect(authorSearch).toBeFocused()
  await expect(authorChip(page, 'Anne Able')).toHaveAttribute('aria-pressed', 'true')

  await page.getByTestId('library-filter-status-all').click()
  await expect(authorSearch).toHaveCount(0)
  await expect(authorChip(page, 'Anne Able')).toHaveAttribute('aria-pressed', 'true')
  await expect(authorChip(page, 'Clara Cove')).toBeVisible()

  await page.keyboard.press(tagSearchShortcut)
  const tagSearch = page.getByRole('textbox', { name: msg('home.library_filter.search_tags') })
  await expect(tagSearch).toBeFocused()
  await tagSearch.fill('NOTE')
  await expect(page.getByTestId('library-tag-chip').filter({ hasText: 'Notes' })).toBeVisible()
  await expect(page.getByTestId('library-tag-chip').filter({ hasText: 'Reference' })).toHaveCount(0)
  await expect(authorChip(page, 'Clara Cove')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(tagSearch).toHaveCount(0)
  await expect(authorChip(page, 'Anne Able')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(authorChip(page, 'Anne Able')).toHaveAttribute('aria-pressed', 'false')
})
