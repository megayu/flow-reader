import { expect, test } from '@playwright/test'

import type { BookRecord } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { epubFixturePackageUrl, installEpubFixtureRoutes } from '../support/epub-fixture'
import { msg } from '../support/i18n'
import { installTauriMock } from '../support/tauri-mock'

const missingArchiveBook: BookRecord = createTestBook({
  id: 'missing-archive',
  name: 'missing.epub',
  size: 1024,
  metadata: { title: 'Missing Archive' },
  createdAt: 1,
  definitions: [],
  annotations: [],
  archive: true,
  editable: false,
  sourcePath: '/fixtures/missing.epub',
})

const referencedBook: BookRecord = createTestBook({
  ...missingArchiveBook,
  id: 'referenced-book',
  name: 'referenced.epub',
  metadata: { title: 'Referenced Book' },
  archive: undefined,
  editable: true,
  sourcePath: '/fixtures/referenced.epub',
})

const editableManagedBook = createTestBook({
  id: 'editable-managed-epub',
  name: 'editable.epub',
  size: 1024,
  metadata: { title: 'Editable EPUB' },
  createdAt: 1,
  definitions: [],
  annotations: [],
  managed: true,
  editable: true,
  sourcePath: 'editable.epub',
})

const managedBook: BookRecord = createTestBook({
  ...referencedBook,
  id: 'managed-book',
  name: 'managed.epub',
  metadata: { title: 'Managed Book' },
  managed: true,
  sourcePath: 'managed.epub',
})

test('shift click reveals only an available referenced source in normal mode', async ({ page }) => {
  await installTauriMock(page, {
    books: [referencedBook, missingArchiveBook, managedBook],
    revealableBookSourceIds: [referencedBook.id],
    sourceStatuses: { [missingArchiveBook.id]: 'missing' },
  })
  await page.goto('/')

  const cover = (title: string) =>
    page.locator('[data-flow-library-book-card]').filter({ hasText: title }).locator('img[alt="Cover"]')

  await cover('Referenced Book').click({ modifiers: ['Shift'] })
  await cover('Missing Archive').click({ modifiers: ['Shift'] })
  await cover('Managed Book').click({ modifiers: ['Shift'] })

  const revealedIds = await page.evaluate(() => (window as any).__FLOW_TEST_TAURI__?.revealedBookSourceIds as string[])
  expect(revealedIds).toEqual([referencedBook.id])
  await expect(page.locator('[data-flow-reader]')).toHaveCount(0)
})

test('replaces the archive badge and warns when its referenced source is missing', async ({ page }) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    sourceStatuses: { [missingArchiveBook.id]: 'missing' },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await expect(card.locator('svg.lucide-book-x')).toBeVisible()
  await expect(card.locator('svg.lucide-archive')).toHaveCount(0)

  await card.click()
  const alert = page
    .getByRole('alert')
    .filter({
      hasText: msg('home.source_unavailable'),
    })
    .last()
  await expect(alert).toContainText(msg('home.source_unavailable'))
  await expect(alert).toContainText('moved or deleted')
  await expect(page.locator('[data-flow-reader]')).toHaveCount(0)
})

test('closes a referenced archive tab and notifies when its source is unreadable during open', async ({ page }) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    readerSourceErrors: {
      [missingArchiveBook.id]: 'BOOK_SOURCE_UNREADABLE',
    },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await card.click()

  const alert = page
    .getByRole('alert')
    .filter({
      hasText: msg('home.source_unavailable'),
    })
    .last()
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('permissions')
  await expect(card).toBeVisible()
  await expect(page.locator('[data-flow-reader-content]')).toHaveCount(0)
})

test('keeps a missing source distinct when it disappears during open', async ({ page }) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    readerSourceErrors: {
      [missingArchiveBook.id]: 'BOOK_SOURCE_MISSING',
    },
  })
  await page.goto('/')

  await page.locator('[data-flow-library-book-card]').click()
  const alert = page
    .getByRole('alert')
    .filter({
      hasText: msg('home.source_unavailable'),
    })
    .last()
  await expect(alert).toContainText('moved or deleted')
  await expect(alert).not.toContainText('permissions')
})

test('keeps archive mode available without comparing the referenced file contents', async ({ page }) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    sourceStatuses: { [missingArchiveBook.id]: 'available' },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await expect(card.locator('svg.lucide-file-x-corner')).toHaveCount(0)
  await expect(card.locator('svg.lucide-archive')).toBeVisible()
})

test('keeps the reading tab open until a changed-source mode switch is resolved', async ({ page }) => {
  const book = editableManagedBook
  await installEpubFixtureRoutes(page)
  await installTauriMock(page, {
    books: [book],
    contentModeSwitchConflicts: { [book.id]: 'changed' },
    readerSources: { [book.id]: epubFixturePackageUrl },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await card.click()
  await expect(page.locator('[data-flow-reader-tab-index]').filter({ hasText: 'Editable EPUB' })).toBeVisible()
  await page.keyboard.press('v')
  await expect(card).toBeVisible()

  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.content_mode.to_archive') }).click()
  let dialog = page.getByRole('dialog', { name: msg('home.content_mode.to_archive') })
  const confirmButton = dialog.getByRole('button', { name: msg('home.context.confirm') })
  await expect(confirmButton).toBeFocused()
  await confirmButton.click()

  dialog = page.getByRole('dialog', { name: msg('home.content_mode.source_conflict_title') })
  await expect(dialog).toBeVisible()
  await expect(page.locator('[data-flow-reader-tab-index]')).toHaveCount(1)
  const saveButton = dialog.getByRole('button', { name: msg('home.content_mode.overwrite_source') })
  await expect(saveButton).toBeFocused()
  await saveButton.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-flow-reader-tab-index]')).toHaveCount(0)

  const state = await page.evaluate(() => (window as any).__FLOW_TEST_TAURI__)
  expect(state.books[0].editable).toBe(false)
  expect(state.contentModeSwitchOperations).toEqual([{ editable: false, id: book.id, resolution: 'overwrite' }])
})

test('recreates an unavailable EPUB before switching it to read-only', async ({ page }) => {
  const book = editableManagedBook
  await installTauriMock(page, {
    books: [book],
    contentModeSwitchConflicts: { [book.id]: 'missing' },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.content_mode.to_archive') }).click()
  let dialog = page.getByRole('dialog', { name: msg('home.content_mode.to_archive') })
  await dialog.getByRole('button', { name: msg('home.context.confirm') }).click()

  dialog = page.getByRole('dialog', { name: msg('home.content_mode.source_missing_title') })
  await expect(dialog).toContainText(msg('home.content_mode.source_missing'))
  await dialog.getByRole('button', { name: msg('home.content_mode.recreate_source') }).click()
  await expect(dialog).toHaveCount(0)

  const state = await page.evaluate(() => (window as any).__FLOW_TEST_TAURI__)
  expect(state.books[0].editable).toBe(false)
  expect(state.contentModeSwitchOperations).toEqual([{ editable: false, id: book.id, resolution: 'overwrite' }])
})

test('reports a native content-mode switch failure without changing the book mode', async ({ page }) => {
  const book = editableManagedBook
  await installTauriMock(page, {
    books: [book],
    contentModeSwitchErrors: { [book.id]: 'Unable to write EPUB' },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await card.click({ button: 'right' })
  await page.getByRole('menuitem', { name: msg('home.content_mode.to_archive') }).click()
  const dialog = page.getByRole('dialog', { name: msg('home.content_mode.to_archive') })
  await dialog.getByRole('button', { name: msg('home.context.confirm') }).click()

  const alert = page
    .getByRole('alert')
    .filter({ hasText: msg('error.content_mode_switch_failed') })
    .last()
  await expect(alert).toContainText('Unable to write EPUB')
  const state = await page.evaluate(() => (window as any).__FLOW_TEST_TAURI__)
  expect(state.books[0].editable).toBe(true)
})
