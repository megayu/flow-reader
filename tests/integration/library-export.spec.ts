import path from 'node:path'

import { expect, test } from '@playwright/test'

import type { BookRecord } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import { getExportedBooks, installTauriMock } from '../support/tauri-mock'

const settingsShortcut = process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'
const exportAction = msg('home.context.export')

const modifiedBook: BookRecord = createTestBook({
  id: 'txt-book',
  name: 'Correctable.txt',
  size: 1024,
  sourceFormat: 'txt',
  contentEditedAt: 123,
  contentHash: 'hash',
  contentVersion: 2,
  metadata: {
    title: 'Correctable',
  },
  createdAt: 1,
  definitions: [],
  annotations: [],
})

test('library modified-book indicator is disabled by default and can be enabled', async ({ page }) => {
  await installTauriMock(page, { books: [modifiedBook] })
  await page.goto('/')

  const indicator = page.locator('[data-flow-library-book-card] svg.lucide-download')
  await expect(indicator).toHaveCount(0)

  await page.keyboard.press(settingsShortcut)
  const dialog = page.getByRole('dialog')
  const checkbox = dialog.getByRole('checkbox', {
    name: msg('settings.library_modified_indicator'),
  })
  await expect(checkbox).not.toBeChecked()
  await checkbox.click()
  await page.keyboard.press('Escape')

  await expect(indicator).toBeVisible()
})

test('exporting either TXT format clears the shared indicator and export marker', async ({ page }) => {
  const outputPath = path.join('tmp', 'Correctable.epub')
  await installTauriMock(page, {
    books: [modifiedBook],
    saveDialogPath: outputPath,
    settings: { showModifiedBookExportIndicator: true },
  })
  await page.goto('/')

  const indicator = page.locator('[data-flow-library-book-card] svg.lucide-download')
  await expect(indicator).toBeVisible()
  await page.getByText('Correctable', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: `${exportAction} *` }).click()
  await expect(page.getByRole('menuitem', { name: 'TXT' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'EPUB' }).click()

  await expect(indicator).toHaveCount(0)
  await page.getByText('Correctable', { exact: true }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: exportAction, exact: true })).toBeVisible()
})

test('TXT book context menu expands formats and exports the selected format', async ({ page }) => {
  const outputPath = path.join('tmp', 'Correctable.txt')

  await installTauriMock(page, {
    books: [
      createTestBook({
        id: 'txt-book',
        name: 'Correctable.txt',
        size: 1024,
        sourceFormat: 'txt',
        contentHash: 'hash',
        contentVersion: 2,
        metadata: {
          title: 'Correctable',
        },
        createdAt: 1,
        definitions: [],
        annotations: [],
      }),
    ],
    saveDialogPath: outputPath,
  })
  await page.goto('/')

  await expect(page.getByText('Correctable')).toBeVisible()
  await page.getByText('Correctable', { exact: true }).click({ button: 'right' })

  await page.getByRole('menuitem', { name: exportAction, exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'EPUB' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'TXT' }).click()
  await expect
    .poll(() => getExportedBooks(page))
    .toEqual([
      {
        id: 'txt-book',
        format: 'txt',
        outputPath,
      },
    ])

  await page.getByText('Correctable', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: exportAction, exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'EPUB' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'TXT' })).toBeVisible()
})
