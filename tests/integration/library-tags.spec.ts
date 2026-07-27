import { expect, test, type Page } from '@playwright/test'

import type { BookRecord, ReadingStatus } from '../../src/db'
import { createTestBook } from '../support/book-fixtures'
import {
  getStoredSettings,
  installTauriMock,
  type TestLibraryTagRecord,
} from '../support/tauri-mock'

function createBook({
  creator = 'Author',
  id,
  readingStatus,
  tagIds = [],
  title,
}: {
  creator?: string
  id: string
  readingStatus?: ReadingStatus
  tagIds?: string[]
  title: string
}): BookRecord {
  return createTestBook({
    id,
    name: `${title}.epub`,
    size: 128000,
    readingStatus,
    tagIds,
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

const fixtureTags: TestLibraryTagRecord[] = [
  { id: 'tag-research', name: 'Research', createdAt: 1 },
  { id: 'tag-archive', name: 'Archive', createdAt: 2 },
  {
    id: 'tag-long',
    name: 'A Very Long Tag Name That Should Ellipsize In The Sidebar',
    createdAt: 3,
  },
]

const fixtureBooks = [
  createBook({
    id: 'alpha',
    title: 'Alpha Research',
    readingStatus: 'read',
    tagIds: ['tag-research'],
  }),
  createBook({
    id: 'beta',
    title: 'Beta Plain',
    readingStatus: 'reading',
  }),
  createBook({
    id: 'gamma',
    title: 'Gamma Archive',
    readingStatus: 'read',
    tagIds: ['tag-archive'],
  }),
]

test('library tag filters refresh from books matching the selected reading status', async ({
  page,
}) => {
  await installTauriMock(page, {
    books: [
      createBook({
        id: 'done',
        title: 'Done Book',
        readingStatus: 'read',
        tagIds: ['tag-done'],
      }),
      createBook({
        id: 'active',
        title: 'Active Book',
        readingStatus: 'reading',
        tagIds: ['tag-active'],
      }),
      createBook({
        id: 'later',
        title: 'Later Book',
        readingStatus: 'toRead',
        tagIds: ['tag-later'],
      }),
    ],
    settings: {
      librarySidebarOpen: false,
    },
    tags: [
      { id: 'tag-done', name: 'Done', createdAt: 1 },
      { id: 'tag-active', name: 'Active', createdAt: 2 },
      { id: 'tag-later', name: 'Later', createdAt: 3 },
    ],
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()
  await openLibraryFilterPanel(page)

  await expect(tagChip(page, 'Done')).toBeVisible()
  await expect(tagChip(page, 'Active')).toBeVisible()
  await expect(tagChip(page, 'Later')).toBeVisible()

  await page.getByTestId('library-filter-status-reading').click()
  await expect(tagChip(page, 'Active')).toBeVisible()
  await expect(tagChip(page, 'Done')).toHaveCount(0)
  await expect(tagChip(page, 'Later')).toHaveCount(0)
})

async function setupLibrary(page: Page) {
  await installTauriMock(page, {
    books: fixtureBooks,
    settings: {
      librarySidebarOpen: false,
    },
    tags: fixtureTags,
  })
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.getByText('Alpha Research')).toBeVisible()

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

function bookCard(page: Page, title: string) {
  return page
    .locator('ul.grid [data-flow-library-book-card]')
    .filter({ hasText: title })
}

function tagChip(page: Page, tag: string) {
  return page.getByTestId('library-tag-chip').filter({ hasText: tag })
}

async function pinnedTags(page: Page) {
  const settings = (await getStoredSettings(page)) as {
    libraryPinnedTags?: string[]
  }

  return settings.libraryPinnedTags ?? []
}

test('library tags can be filtered, pinned, edited, batch-applied, renamed, deleted, and persisted', async ({
  page,
}) => {
  await setupLibrary(page)

  await expect(page.getByTestId('library-tag-section')).toBeVisible()
  await expect(tagChip(page, 'Research')).toBeVisible()
  await expect(tagChip(page, 'Archive')).toBeVisible()
  await expect(tagChip(page, 'Research')).not.toHaveAttribute('title', /.+/)
  await expect(
    tagChip(page, 'A Very Long Tag Name That Should Ellipsize In The Sidebar'),
  ).toHaveAttribute(
    'title',
    'A Very Long Tag Name That Should Ellipsize In The Sidebar',
  )

  const tagSection = page.getByTestId('library-tag-section')
  await tagSection.getByRole('button', { name: /^New tag$/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await tagSection.getByRole('textbox', { name: /^New tag$/ }).fill('Later')
  await tagSection.getByRole('textbox', { name: /^New tag$/ }).press('Enter')
  await expect(tagChip(page, 'Later')).toBeVisible()

  await tagChip(page, 'Research').click()
  await expect(page.getByText('Alpha Research')).toBeVisible()
  await expect(page.getByText('Beta Plain')).toHaveCount(0)
  await expect(page.getByText('Gamma Archive')).toHaveCount(0)

  await tagChip(page, 'Research').click({ button: 'right' })
  await page
    .getByTestId('library-tag-context-menu')
    .getByRole('menuitem', { name: /^Pin$/ })
    .click()
  await expect.poll(() => pinnedTags(page)).toEqual(['tag-research'])

  await tagChip(page, 'Research').click()
  await bookCard(page, 'Beta Plain').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Edit$/ }).click()
  let editDialog = page.getByRole('dialog')
  await expect(
    editDialog.getByRole('heading', { name: /^Edit book$/ }),
  ).toBeVisible()
  await expect(
    editDialog.getByRole('textbox', { name: /^New tag$/ }),
  ).toHaveCount(0)
  await editDialog.getByRole('button', { name: /^Cancel$/ }).click()

  await bookCard(page, 'Beta Plain').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Tags$/ }).click()
  editDialog = page.getByRole('dialog')
  await expect(
    editDialog.getByRole('heading', { name: /^Edit tags$/ }),
  ).toBeVisible()
  await editDialog.getByRole('textbox', { name: /^New tag$/ }).fill('Scratch')
  await editDialog.getByRole('button', { name: /^Add tag$/ }).click()
  await expect(
    editDialog.getByRole('button', { name: /^Scratch$/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await editDialog.getByRole('button', { name: /^Cancel$/ }).click()
  await expect(tagChip(page, 'Scratch')).toHaveCount(0)

  await bookCard(page, 'Beta Plain').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Tags$/ }).click()
  editDialog = page.getByRole('dialog')
  await editDialog
    .getByRole('textbox', { name: /^New tag$/ })
    .fill(' research ')
  await editDialog.getByRole('button', { name: /^Add tag$/ }).click()
  await expect(
    editDialog.getByRole('button', { name: /^Research$/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    editDialog.getByRole('button', { name: /^Research$/ }),
  ).toHaveCount(1)
  await editDialog.getByRole('textbox', { name: /^New tag$/ }).fill('Priority')
  await editDialog.getByRole('button', { name: /^Add tag$/ }).click()
  await editDialog.getByRole('textbox', { name: /^New tag$/ }).fill('priority')
  await editDialog.getByRole('button', { name: /^Add tag$/ }).click()
  await expect(
    editDialog.getByRole('button', { name: /^Priority$/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    editDialog.getByRole('button', { name: /^Priority$/ }),
  ).toHaveCount(1)
  await editDialog.getByRole('button', { name: /^Apply$/ }).click()

  await expect(tagChip(page, 'Priority')).toBeVisible()
  await expect(tagChip(page, 'Priority')).toHaveCount(1)
  await tagChip(page, 'Priority').click()
  await expect(page.getByText('Beta Plain')).toBeVisible()
  await expect(page.getByText('Alpha Research')).toHaveCount(0)

  await tagChip(page, 'Priority').click()
  await page.getByRole('button', { name: /^Select$/ }).click()
  await bookCard(page, 'Alpha Research').click()
  await bookCard(page, 'Gamma Archive').click()
  await page.getByRole('button', { name: /^Tags$/ }).click()

  const batchDialog = page.getByRole('dialog')
  await expect(
    batchDialog.getByRole('heading', { name: /^Edit tags$/ }),
  ).toBeVisible()
  await expect(
    batchDialog.getByRole('button', { name: /^Research$/ }),
  ).toHaveAttribute('aria-pressed', 'mixed')
  await expect(
    batchDialog.getByRole('button', { name: /^Research$/ }).locator('svg'),
  ).toHaveCount(0)
  await batchDialog.getByRole('button', { name: /^Research$/ }).click()
  await expect(
    batchDialog.getByRole('button', { name: /^Research$/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await batchDialog.getByRole('textbox', { name: /^New tag$/ }).fill('Batch')
  await batchDialog.getByRole('button', { name: /^Add tag$/ }).click()
  await batchDialog.getByRole('textbox', { name: /^New tag$/ }).fill('batch')
  await batchDialog.getByRole('button', { name: /^Add tag$/ }).click()
  await expect(
    batchDialog.getByRole('button', { name: /^Batch$/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(
    batchDialog.getByRole('button', { name: /^Batch$/ }),
  ).toHaveCount(1)
  await batchDialog.getByRole('button', { name: /^Apply$/ }).click()
  await page.getByRole('button', { name: /^Cancel$/ }).click()

  await tagChip(page, 'Research').click()
  await expect(page.getByText('Alpha Research')).toBeVisible()
  await expect(page.getByText('Gamma Archive')).toBeVisible()
  await expect(page.getByText('Beta Plain')).toBeVisible()
  await tagChip(page, 'Research').click()
  await expect(tagChip(page, 'Batch')).toBeVisible()

  await tagChip(page, 'Priority').click({ button: 'right' })
  await page
    .getByTestId('library-tag-context-menu')
    .getByRole('menuitem', { name: /^Edit tag$/ })
    .click()
  const tagDialog = page.getByRole('dialog')
  await expect(
    tagDialog.getByRole('heading', { name: /^Edit tag$/ }),
  ).toBeVisible()
  await tagDialog.getByRole('textbox', { name: /^Tag name$/ }).fill('Important')
  await tagDialog.getByRole('button', { name: /^Save$/ }).click()
  await expect(tagChip(page, 'Priority')).toHaveCount(0)
  await expect(tagChip(page, 'Important')).toBeVisible()

  await tagChip(page, 'Important').click({ button: 'right' })
  await page
    .getByTestId('library-tag-context-menu')
    .getByRole('menuitem', { name: /^Delete tag$/ })
    .click()
  await page.getByRole('button', { name: /^Delete tag$/ }).click()
  await expect(tagChip(page, 'Important')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.getByText('Alpha Research')).toBeVisible()
  await openLibraryFilterPanel(page)
  await expect.poll(() => pinnedTags(page)).toEqual(['tag-research'])
  await expect(tagChip(page, 'Research')).toBeVisible()
  await expect(tagChip(page, 'Important')).toHaveCount(0)
})
