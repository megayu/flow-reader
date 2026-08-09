import { expect, type Locator, type Page, test } from '@playwright/test'

import type { BookRecord, ReadingStatus } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import {
  getStoredLibraryMockState,
  getStoredLibraryPins,
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

const researchTag: TestLibraryTagRecord = { id: 'tag-research', name: 'Research', createdAt: 1 }
const archiveTag: TestLibraryTagRecord = { id: 'tag-archive', name: 'Archive', createdAt: 2 }
const orphanTag: TestLibraryTagRecord = {
  id: 'tag-long',
  name: 'A Very Long Tag Name That Should Ellipsize In The Sidebar',
  createdAt: 3,
}
const fixtureTags = [researchTag, archiveTag, orphanTag]
const settingsShortcut = process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'

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

test('library tag filters refresh from books matching the selected reading status', async ({ page }) => {
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

    await page.getByRole('button', { name: msg('home.library_filter.title') }).click()
    await page.waitForTimeout(100)
  }

  await expect(panel).toBeVisible()
}

function bookCard(page: Page, title: string) {
  return page.locator('ul.grid [data-flow-library-book-card]').filter({ hasText: title })
}

function tagChip(page: Page, tag: string) {
  return page.getByTestId('library-tag-chip').filter({ hasText: tag })
}

async function pinnedTags(page: Page) {
  return (await getStoredLibraryPins(page)).tagIds
}

async function openTagSettings(page: Page) {
  await page.keyboard.press(settingsShortcut)
  const settings = page.getByRole('dialog', { name: msg('settings.title') })
  await settings.getByRole('button', { name: msg('settings.tabs.tags'), exact: true }).click()
  return settings
}

function tagOption(container: Locator | Page, name: string) {
  return container.getByRole('button', { name, exact: true })
}

test('tag settings keep selection while search changes the visible select-all scope', async ({ page }) => {
  await installTauriMock(page, {
    books: fixtureBooks,
    tags: fixtureTags,
  })
  await page.goto('/')
  const settings = await openTagSettings(page)

  const search = settings.getByRole('textbox', { name: msg('settings.tags.search') })
  const clearSearch = settings.getByRole('button', { name: msg('settings.tags.search') })
  const selectAll = settings.getByRole('button', { name: msg('settings.tags.select_all'), exact: true })
  const deselectAll = settings.getByRole('button', { name: msg('home.deselect_all'), exact: true })
  const merge = settings.getByRole('button', { name: msg('settings.tags.merge_action'), exact: true })
  const remove = settings.getByRole('button', { name: msg('home.delete'), exact: true })
  const clearOrphans = settings.getByRole('button', { name: msg('settings.tags.clear_orphans'), exact: true })

  await expect(settings.getByRole('textbox', { name: msg('settings.tags.new') })).toBeVisible()
  await expect(deselectAll).toBeDisabled()
  await expect(merge).toBeDisabled()
  await expect(remove).toBeDisabled()
  await expect(clearOrphans).toBeEnabled()

  await search.fill('No matching tag')
  await expect(settings.getByText(msg('settings.tags.no_tags'), { exact: true })).toBeVisible()
  await expect(selectAll).toBeDisabled()
  await clearSearch.click()
  await expect(selectAll).toBeEnabled()

  await clearOrphans.click()
  const clearOrphansDialog = page.getByRole('dialog', { name: msg('settings.tags.clear_orphans') })
  await expect(clearOrphansDialog.getByRole('button', { name: msg('settings.tags.clear'), exact: true })).toBeVisible()
  await clearOrphansDialog.getByRole('button', { name: msg('home.cancel'), exact: true }).click()

  await search.fill(researchTag.name)
  await selectAll.click()
  await clearSearch.click()
  await expect(tagOption(settings, researchTag.name)).toHaveAttribute('aria-pressed', 'true')
  await expect(tagOption(settings, archiveTag.name)).toHaveAttribute('aria-pressed', 'false')
  await expect(remove).toBeEnabled()
  await expect(merge).toBeDisabled()

  await search.fill(researchTag.name)
  await selectAll.click()
  await expect(tagOption(settings, researchTag.name)).toHaveAttribute('aria-pressed', 'false')
  await expect(remove).toBeDisabled()
  await selectAll.click()
  await clearSearch.click()

  await search.fill(archiveTag.name)
  await expect(tagOption(settings, archiveTag.name)).toBeVisible()
  await selectAll.click()
  await clearSearch.click()
  await expect(tagOption(settings, researchTag.name)).toHaveAttribute('aria-pressed', 'true')
  await expect(tagOption(settings, archiveTag.name)).toHaveAttribute('aria-pressed', 'true')
  await expect(merge).toBeEnabled()

  await deselectAll.click()
  await expect(tagOption(settings, researchTag.name)).toHaveAttribute('aria-pressed', 'false')
  await expect(tagOption(settings, archiveTag.name)).toHaveAttribute('aria-pressed', 'false')
  await expect(deselectAll).toBeDisabled()
  await expect(merge).toBeDisabled()
  await expect(remove).toBeDisabled()
})

test('tag settings create, edit, delete, batch-delete, and clear orphan tags', async ({ page }) => {
  await installTauriMock(page, { books: fixtureBooks, tags: fixtureTags })
  await page.goto('/')
  const settings = await openTagSettings(page)
  const newTag = settings.getByRole('textbox', { name: msg('settings.tags.new') })

  await newTag.fill('  Focus   Tag  ')
  await newTag.press('Enter')
  await expect(tagOption(settings, 'Focus Tag')).toBeVisible()
  await newTag.fill('focus tag')
  await newTag.press('Enter')
  await expect
    .poll(async () => (await getStoredLibraryMockState(page)).tags.filter((tag) => tag.name === 'Focus Tag').length)
    .toBe(1)

  await tagOption(settings, 'Focus Tag').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.context.edit'), exact: true }).click()
  let dialog = page.getByRole('dialog', { name: msg('home.library_filter.edit_tag') })
  const tagName = dialog.getByRole('textbox', { name: msg('home.library_filter.tag_name') })
  const save = dialog.getByRole('button', { name: msg('home.edit.save'), exact: true })
  await expect(save).toBeDisabled()
  await tagName.fill('   ')
  await expect(save).toBeDisabled()
  await tagName.fill(researchTag.name)
  await save.click()
  await expect(tagOption(settings, 'Focus Tag')).toBeVisible()

  await tagOption(settings, 'Focus Tag').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.context.edit'), exact: true }).click()
  dialog = page.getByRole('dialog', { name: msg('home.library_filter.edit_tag') })
  await dialog.getByRole('textbox', { name: msg('home.library_filter.tag_name') }).fill('Priority')
  await dialog.getByRole('button', { name: msg('home.edit.save'), exact: true }).click()
  await expect(tagOption(settings, 'Priority')).toBeVisible()

  await tagOption(settings, 'Priority').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.delete'), exact: true }).click()
  dialog = page.getByRole('dialog', { name: msg('home.library_filter.delete_tag') })
  await dialog.getByRole('button', { name: msg('home.cancel'), exact: true }).click()
  await expect(tagOption(settings, 'Priority')).toBeVisible()
  await tagOption(settings, 'Priority').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.delete'), exact: true }).click()
  await page
    .getByRole('dialog', { name: msg('home.library_filter.delete_tag') })
    .getByRole('button', { name: msg('home.delete'), exact: true })
    .click()
  await expect(tagOption(settings, 'Priority')).toHaveCount(0)

  const clearOrphans = settings.getByRole('button', { name: msg('settings.tags.clear_orphans'), exact: true })
  await clearOrphans.click()
  await page
    .getByRole('dialog', { name: msg('settings.tags.clear_orphans') })
    .getByRole('button', { name: msg('settings.tags.clear'), exact: true })
    .click()
  await expect(tagOption(settings, orphanTag.name)).toHaveCount(0)
  await expect(clearOrphans).toBeDisabled()

  await tagOption(settings, researchTag.name).click()
  await tagOption(settings, archiveTag.name).click()
  await settings.getByRole('button', { name: msg('home.delete'), exact: true }).click()
  await page
    .getByRole('dialog', { name: msg('settings.tags.delete_selected') })
    .getByRole('button', { name: msg('home.delete'), exact: true })
    .click()

  await expect(settings.getByText(msg('settings.tags.no_tags'), { exact: true })).toBeVisible()
  await expect
    .poll(async () => await getStoredLibraryMockState(page))
    .toMatchObject({
      books: [
        { id: 'alpha', tagIds: [] },
        { id: 'beta', tagIds: [] },
        { id: 'gamma', tagIds: [] },
      ],
      tags: [],
    })
})

test('tag settings merge into a selected tag or a new name and explain name conflicts', async ({ page }) => {
  await installTauriMock(page, {
    books: fixtureBooks,
    pins: { authors: [], tagIds: [archiveTag.id] },
    tags: fixtureTags,
  })
  await page.goto('/')
  const settings = await openTagSettings(page)
  const merge = settings.getByRole('button', { name: msg('settings.tags.merge_action'), exact: true })

  await tagOption(settings, researchTag.name).click()
  await tagOption(settings, archiveTag.name).click()
  await merge.click()
  let dialog = page.getByRole('dialog', { name: msg('settings.tags.merge') })
  let name = dialog.getByRole('textbox', { name: msg('settings.tags.merge_name') })
  let confirm = dialog.getByRole('button', { name: msg('settings.tags.merge_action'), exact: true })
  await name.fill('   ')
  await expect(confirm).toBeDisabled()
  await name.fill(orphanTag.name)
  await confirm.click()
  await expect(page.getByText(msg('settings.tags.merge_error'), { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()

  await tagOption(dialog, researchTag.name).click()
  await expect(name).toHaveValue('')
  await confirm.click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () => await getStoredLibraryMockState(page))
    .toMatchObject({
      books: [
        { id: 'alpha', tagIds: [researchTag.id] },
        { id: 'beta', tagIds: [] },
        { id: 'gamma', tagIds: [researchTag.id] },
      ],
      tags: [{ id: researchTag.id }, { id: orphanTag.id }],
    })
  await expect.poll(() => pinnedTags(page)).toEqual([researchTag.id])

  await tagOption(settings, researchTag.name).click()
  await tagOption(settings, orphanTag.name).click()
  await merge.click()
  dialog = page.getByRole('dialog', { name: msg('settings.tags.merge') })
  name = dialog.getByRole('textbox', { name: msg('settings.tags.merge_name') })
  confirm = dialog.getByRole('button', { name: msg('settings.tags.merge_action'), exact: true })
  await name.fill('Unified')
  await confirm.click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () => await getStoredLibraryMockState(page))
    .toMatchObject({
      books: [
        { id: 'alpha', tagIds: [expect.any(String)] },
        { id: 'beta', tagIds: [] },
        { id: 'gamma', tagIds: [expect.any(String)] },
      ],
      tags: [{ name: 'Unified' }],
    })
  const state = await getStoredLibraryMockState(page)
  expect(state.books[0]?.tagIds).toEqual([state.tags[0]?.id])
  expect(state.books[2]?.tagIds).toEqual([state.tags[0]?.id])
  await expect.poll(() => pinnedTags(page)).toEqual([state.tags[0]?.id])
})

test('library tags can be filtered, pinned, edited, batch-applied, renamed, deleted, and persisted', async ({
  page,
}) => {
  await setupLibrary(page)

  await expect(page.getByTestId('library-tag-section')).toBeVisible()
  await expect(tagChip(page, 'Research')).toBeVisible()
  await expect(tagChip(page, 'Archive')).toBeVisible()
  await expect(tagChip(page, 'Research')).not.toHaveAttribute('title', /.+/)
  await expect(tagChip(page, 'A Very Long Tag Name That Should Ellipsize In The Sidebar')).toHaveAttribute(
    'title',
    'A Very Long Tag Name That Should Ellipsize In The Sidebar',
  )

  const tagSection = page.getByTestId('library-tag-section')
  await tagSection.getByRole('button', { name: msg('home.library_filter.new_tag') }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page
    .getByTestId('library-status-filter')
    .getByRole('button', { name: msg('home.library_filter.all') })
    .click()
  await expect(tagSection.getByRole('textbox', { name: msg('home.library_filter.new_tag') })).toHaveCount(0)
  await tagSection.getByRole('button', { name: msg('home.library_filter.new_tag') }).click()
  await tagSection.getByRole('textbox', { name: msg('home.library_filter.new_tag') }).fill('Later')
  await tagSection.getByRole('textbox', { name: msg('home.library_filter.new_tag') }).press('Enter')
  await expect(tagChip(page, 'Later')).toBeVisible()

  await tagChip(page, 'Research').click()
  await expect(page.getByText('Alpha Research')).toBeVisible()
  await expect(page.getByText('Beta Plain')).toHaveCount(0)
  await expect(page.getByText('Gamma Archive')).toHaveCount(0)

  await tagChip(page, 'Research').click({ button: 'right' })
  await page
    .getByTestId('library-tag-context-menu')
    .getByRole('menuitem', { name: msg('home.library_filter.pin_tag') })
    .click()
  await expect.poll(() => pinnedTags(page)).toEqual(['tag-research'])

  await tagChip(page, 'Research').click()
  await bookCard(page, 'Beta Plain').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.context.edit') }).click()
  let editDialog = page.getByRole('dialog')
  await expect(editDialog.getByRole('heading', { name: msg('home.edit.dialog_title') })).toBeVisible()
  await expect(editDialog.getByRole('textbox', { name: msg('home.edit.new_tag') })).toHaveCount(0)
  const titleInput = editDialog.getByRole('textbox', { name: msg('home.edit.title') })
  const creatorInput = editDialog.getByRole('textbox', { name: msg('home.edit.creator') })
  const saveBookButton = editDialog.getByRole('button', { name: msg('home.edit.save') })
  await expect(saveBookButton).toBeDisabled()
  const hasCaretAtEnd = (input: typeof titleInput) =>
    input.evaluate((element) => {
      const { selectionEnd, selectionStart, value } = element as HTMLInputElement
      return selectionStart === value.length && selectionEnd === value.length
    })
  await page.keyboard.press('Tab')
  await expect(creatorInput).toBeFocused()
  await expect.poll(() => hasCaretAtEnd(creatorInput)).toBe(true)
  await page.keyboard.press('Tab')
  await expect(editDialog.getByRole('button', { name: msg('home.cancel') })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(editDialog.locator('[data-slot="dialog-close"]')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(titleInput).toBeFocused()
  await expect.poll(() => hasCaretAtEnd(titleInput)).toBe(true)
  await titleInput.fill('Beta Revised')
  await expect(saveBookButton).toBeEnabled()
  await editDialog.getByRole('button', { name: msg('home.cancel') }).click()

  await bookCard(page, 'Beta Plain').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.tags') }).click()
  editDialog = page.getByRole('dialog')
  await expect(editDialog.getByRole('heading', { name: msg('home.tag_editor.title') })).toBeVisible()
  const saveBookTagsButton = editDialog.getByRole('button', { name: msg('home.edit.save') })
  await expect(saveBookTagsButton).toBeDisabled()
  await editDialog.getByRole('textbox', { name: msg('home.edit.new_tag') }).fill('Scratch')
  await editDialog.getByRole('button', { name: msg('home.edit.add_tag') }).click()
  await expect(saveBookTagsButton).toBeEnabled()
  await expect(tagOption(editDialog, 'Scratch')).toHaveAttribute('aria-pressed', 'true')
  await editDialog.getByRole('button', { name: msg('home.cancel') }).click()
  await expect(tagChip(page, 'Scratch')).toHaveCount(0)

  await bookCard(page, 'Beta Plain').click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.tags') }).click()
  editDialog = page.getByRole('dialog')
  await editDialog.getByRole('textbox', { name: msg('home.edit.new_tag') }).fill(' research ')
  await editDialog.getByRole('button', { name: msg('home.edit.add_tag') }).click()
  await expect(tagOption(editDialog, researchTag.name)).toHaveAttribute('aria-pressed', 'true')
  await expect(tagOption(editDialog, researchTag.name)).toHaveCount(1)
  await editDialog.getByRole('textbox', { name: msg('home.edit.new_tag') }).fill('Priority')
  await editDialog.getByRole('button', { name: msg('home.edit.add_tag') }).click()
  await editDialog.getByRole('textbox', { name: msg('home.edit.new_tag') }).fill('priority')
  await editDialog.getByRole('button', { name: msg('home.edit.add_tag') }).click()
  await expect(tagOption(editDialog, 'Priority')).toHaveAttribute('aria-pressed', 'true')
  await expect(tagOption(editDialog, 'Priority')).toHaveCount(1)
  await editDialog.getByRole('button', { name: msg('home.edit.save') }).click()

  await expect(tagChip(page, 'Priority')).toBeVisible()
  await expect(tagChip(page, 'Priority')).toHaveCount(1)
  await tagChip(page, 'Priority').click()
  await expect(page.getByText('Beta Plain')).toBeVisible()
  await expect(page.getByText('Alpha Research')).toHaveCount(0)

  await tagChip(page, 'Priority').click()
  await page.getByRole('button', { name: msg('home.select'), exact: true }).click()
  await bookCard(page, 'Alpha Research').click()
  await bookCard(page, 'Gamma Archive').click()
  await page.getByRole('button', { name: msg('home.tags'), exact: true }).click()

  const batchDialog = page.getByRole('dialog')
  await expect(batchDialog.getByRole('heading', { name: msg('home.tag_editor.title') })).toBeVisible()
  const saveBatchTagsButton = batchDialog.getByRole('button', { name: msg('home.edit.save') })
  await expect(saveBatchTagsButton).toBeDisabled()
  await tagOption(batchDialog, 'Later').click()
  await expect(saveBatchTagsButton).toBeEnabled()
  await tagOption(batchDialog, 'Later').click()
  await expect(saveBatchTagsButton).toBeDisabled()
  await expect(tagOption(batchDialog, researchTag.name)).toHaveAttribute('aria-pressed', 'mixed')
  await expect(tagOption(batchDialog, researchTag.name).locator('svg')).toHaveCount(0)
  await tagOption(batchDialog, researchTag.name).click()
  await expect(saveBatchTagsButton).toBeEnabled()
  await expect(tagOption(batchDialog, researchTag.name)).toHaveAttribute('aria-pressed', 'true')
  await batchDialog.getByRole('textbox', { name: msg('home.edit.new_tag') }).fill('Batch')
  await batchDialog.getByRole('button', { name: msg('home.edit.add_tag') }).click()
  await batchDialog.getByRole('textbox', { name: msg('home.edit.new_tag') }).fill('batch')
  await batchDialog.getByRole('button', { name: msg('home.edit.add_tag') }).click()
  await expect(tagOption(batchDialog, 'Batch')).toHaveAttribute('aria-pressed', 'true')
  await expect(tagOption(batchDialog, 'Batch')).toHaveCount(1)
  await batchDialog.getByRole('button', { name: msg('home.edit.save') }).click()
  await page.getByRole('button', { name: msg('home.cancel'), exact: true }).click()

  await tagChip(page, 'Research').click()
  await expect(page.getByText('Alpha Research')).toBeVisible()
  await expect(page.getByText('Gamma Archive')).toBeVisible()
  await expect(page.getByText('Beta Plain')).toBeVisible()
  await tagChip(page, 'Research').click()
  await expect(tagChip(page, 'Batch')).toBeVisible()

  await tagChip(page, 'Priority').click({ button: 'right' })
  await page
    .getByTestId('library-tag-context-menu')
    .getByRole('menuitem', { name: msg('home.context.edit'), exact: true })
    .click()
  const tagDialog = page.getByRole('dialog')
  await expect(tagDialog.getByRole('heading', { name: msg('home.library_filter.edit_tag') })).toBeVisible()
  await tagDialog.getByRole('textbox', { name: msg('home.library_filter.tag_name') }).fill('Important')
  await tagDialog.getByRole('button', { name: msg('home.edit.save') }).click()
  await expect(tagChip(page, 'Priority')).toHaveCount(0)
  await expect(tagChip(page, 'Important')).toBeVisible()

  await tagChip(page, 'Important').click({ button: 'right' })
  await page
    .getByTestId('library-tag-context-menu')
    .getByRole('menuitem', { name: msg('home.delete'), exact: true })
    .click()
  await page.getByRole('button', { name: msg('home.delete'), exact: true }).click()
  await expect(tagChip(page, 'Important')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.getByText('Alpha Research')).toBeVisible()
  await openLibraryFilterPanel(page)
  await expect.poll(() => pinnedTags(page)).toEqual(['tag-research'])
  await expect(tagChip(page, 'Research')).toBeVisible()
  await expect(tagChip(page, 'Important')).toHaveCount(0)
})
