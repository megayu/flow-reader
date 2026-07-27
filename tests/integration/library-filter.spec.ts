import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import type { BookRecord, ReadingStatus } from '../../src/db'
import { createTestBook } from '../support/book-fixtures'
import { getStoredSettings, installTauriMock } from '../support/tauri-mock'

const longAuthor =
  'Beatrice Longname With An Extraordinarily Extended Family Name That Should Ellipsize'

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
    settings: {
      librarySidebarOpen: false,
    },
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  await openLibraryFilterPanel(page)
}

async function openLibraryFilterPanel(page: Page) {
  const panel = page.getByTestId('library-filter-panel')

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await panel.isVisible()) return

    await page.getByRole('button', { name: /^Filter$/ }).click()
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
  const settings = (await getStoredSettings(page)) as {
    libraryPinnedAuthors?: string[]
  }

  return settings.libraryPinnedAuthors ?? []
}

test('library author filters pin authors and refresh when books change', async ({
  page,
}) => {
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

  const longChipMetrics = await authorChip(page, longAuthor).evaluate(
    (chip) => {
      const label = chip.querySelector(
        '[data-testid="library-author-chip-label"]',
      ) as HTMLElement
      const panel = document.querySelector(
        '[data-testid="library-filter-panel"]',
      ) as HTMLElement
      const labelStyle = getComputedStyle(label)

      return {
        chipWidth: Math.round(chip.getBoundingClientRect().width),
        labelOverflow: labelStyle.overflow,
        panelWidth: Math.round(panel.getBoundingClientRect().width),
        textOverflow: labelStyle.textOverflow,
        whiteSpace: labelStyle.whiteSpace,
      }
    },
  )

  expect(longChipMetrics.chipWidth).toBeLessThanOrEqual(
    longChipMetrics.panelWidth,
  )
  expect(longChipMetrics.labelOverflow).toBe('hidden')
  expect(longChipMetrics.textOverflow).toBe('ellipsis')
  expect(longChipMetrics.whiteSpace).toBe('nowrap')
  await expect(authorChip(page, longAuthor)).toHaveAttribute(
    'title',
    longAuthor,
  )
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
    .getByRole('button', { name: /^Reset$/ })
    .click()
  await expect(page.getByText('Beta Read')).toBeVisible()
  await expect(page.getByText('Gamma Read')).toBeVisible()

  await authorChip(page, longAuthor).click({ button: 'right' })
  await expect(
    page.getByTestId('library-author-context-menu').getByRole('menuitem', {
      name: /^Pin$/,
    }),
  ).toBeVisible()
  await expect(
    page.getByTestId('library-author-context-menu').getByRole('menuitem', {
      name: /^Unpin$/,
    }),
  ).toHaveCount(0)
  await page
    .getByTestId('library-author-context-menu')
    .getByRole('menuitem', { name: /^Pin$/ })
    .click()
  await expect.poll(() => authorNames(page)).toEqual([longAuthor, 'Anne Able'])
  await expect.poll(() => pinnedAuthors(page)).toEqual([longAuthor])

  await authorChip(page, 'Anne Able').click({ button: 'right' })
  await page
    .getByTestId('library-author-context-menu')
    .getByRole('menuitem', { name: /^Pin$/ })
    .click()
  await expect.poll(() => authorNames(page)).toEqual(['Anne Able', longAuthor])
  await expect
    .poll(() => pinnedAuthors(page))
    .toEqual(['Anne Able', longAuthor])

  await authorChip(page, 'Anne Able').click({ button: 'right' })
  await expect(
    page.getByTestId('library-author-context-menu').getByRole('menuitem', {
      name: /^Pin$/,
    }),
  ).toBeVisible()
  await page
    .getByTestId('library-author-context-menu')
    .getByRole('menuitem', { name: /^Unpin$/ })
    .click()
  await expect.poll(() => authorNames(page)).toEqual([longAuthor, 'Anne Able'])
  await expect.poll(() => pinnedAuthors(page)).toEqual([longAuthor])

  await page
    .locator('ul.grid [data-flow-library-book-card]')
    .filter({ hasText: 'Beta Read' })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Delete$/ }).click()
  await page.getByRole('menuitem', { name: /^Confirm delete$/ }).click()
  await expect(page.getByText('Beta Read')).toHaveCount(0)
  await expect(authorChip(page, longAuthor)).toHaveCount(0)
  await expect.poll(() => pinnedAuthors(page)).toEqual([longAuthor])

  await page.getByRole('button', { name: /^Import$/ }).click()
  await expect(page.getByText('Delta Read')).toBeVisible()
  await expect(authorChip(page, 'Dorian Delta')).toBeVisible()

  await page.reload()
  await expect(page.locator('#layout')).toBeVisible()
  await openLibraryFilterPanel(page)
  await expect.poll(() => pinnedAuthors(page)).toEqual([longAuthor])
  await expect.poll(() => authorNames(page)).toContainEqual(longAuthor)
  expect((await authorNames(page))[0]).toBe(longAuthor)
})

test('library filter panel clears filters on Escape without closing', async ({
  page,
}) => {
  await setupLibrary(page)

  await authorChip(page, 'Anne Able').click()
  await expect(page.getByText('Alpha Draft')).toBeVisible()
  await expect(page.getByText('Gamma Read')).toBeVisible()
  await expect(page.getByText('Beta Read')).toHaveCount(0)

  await page.getByRole('button', { name: /^Clear$/ }).hover()
  await expect(page.getByRole('tooltip').locator('kbd')).toContainText(['Esc'])
  await page.mouse.move(500, 500)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-filter-panel')).toBeVisible()
  await expect(authorChip(page, 'Anne Able')).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByText('Beta Read')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('library-filter-panel')).toBeVisible()
})
