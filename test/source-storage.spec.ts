import { expect, test } from '@playwright/test'

import type { BookRecord } from '../src/db'

import { installTauriMock } from './tauri-mock'

const missingArchiveBook: BookRecord = {
  id: 'missing-archive',
  name: 'missing.epub',
  size: 1024,
  metadata: { title: 'Missing Archive' },
  createdAt: 1,
  definitions: [],
  annotations: [],
  contentMode: 'archiveOnly',
  sourceStorage: 'referenced',
  sourcePath: '/fixtures/missing.epub',
  stateLoaded: true,
}

test('replaces the archive badge and warns when its referenced source is missing', async ({
  page,
}) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    sourceStatuses: { [missingArchiveBook.id]: 'missing' },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await expect(card.getByLabel('Original file unavailable')).toBeVisible()
  await expect(card.getByLabel('Archive mode')).toHaveCount(0)

  await card.click()
  const alert = page.getByRole('alert').filter({
    hasText: 'Original file unavailable',
  })
  await expect(alert).toContainText('Original file unavailable')
  await expect(alert).toContainText('moved or deleted')
  await expect(page.locator('[data-flow-reader]')).toHaveCount(0)
})

test('closes a referenced archive tab and notifies when its source fails during open', async ({
  page,
}) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    readerSourceErrors: {
      [missingArchiveBook.id]: 'BOOK_SOURCE_CHANGED',
    },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await card.click()

  const alert = page.getByRole('alert').filter({
    hasText: 'Original file unavailable',
  })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('changed since it was imported')
  await expect(card).toBeVisible()
  await expect(page.locator('[data-flow-reader-content]')).toHaveCount(0)
})

test('keeps a missing source distinct when it disappears during open', async ({
  page,
}) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    readerSourceErrors: {
      [missingArchiveBook.id]: 'BOOK_SOURCE_MISSING',
    },
  })
  await page.goto('/')

  await page.locator('[data-flow-library-book-card]').click()
  const alert = page.getByRole('alert').filter({
    hasText: 'Original file unavailable',
  })
  await expect(alert).toContainText('moved or deleted')
  await expect(alert).not.toContainText('permissions')
})

test('shows source changed instead of archive mode on the cover', async ({
  page,
}) => {
  await installTauriMock(page, {
    books: [missingArchiveBook],
    sourceStatuses: { [missingArchiveBook.id]: 'changed' },
  })
  await page.goto('/')

  const card = page.locator('[data-flow-library-book-card]')
  await expect(card.getByLabel('Original file unavailable')).toBeVisible()
  await expect(card.getByLabel('Archive mode')).toHaveCount(0)

  await card.click()
  const alert = page.getByRole('alert').filter({
    hasText: 'Original file unavailable',
  })
  await expect(alert).toContainText('changed since it was imported')
})
