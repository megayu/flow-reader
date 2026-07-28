import path from 'node:path'

import { expect, test } from '@playwright/test'

import { createTestBook } from '../support/book-fixtures'
import { getImportedTextSelections, installTauriMock } from '../support/tauri-mock'

test('TXT import dialog sends edited title and author metadata', async ({ page }) => {
  const filePath = path.join('tmp', 'Original Title.txt')

  await installTauriMock(page, {
    importedBooks: [
      createTestBook({
        id: 'txt-imported-book',
        name: 'Original Title.txt',
        size: 1024,
        sourceFormat: 'txt',
        contentHash: 'hash',
        metadata: {
          title: 'Edited Title',
          creator: 'Edited Author',
        },
        createdAt: 1,
        definitions: [],
        annotations: [],
      }),
    ],
    openDialogPaths: [filePath],
    textImportPreviews: [
      {
        path: filePath,
        filename: 'Original Title.txt',
        title: 'Original Title',
        encoding: 'utf-8',
        encodingLabel: 'UTF-8',
        confidence: 'high',
        status: 'ready',
        selected: true,
        chapters: [
          {
            level: 1,
            role: 'chapter',
            title: 'Chapter 1',
          },
        ],
        sample: 'Chapter 1\nText preview.',
      },
    ],
  })
  await page.goto('/')

  await page.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('TXT Import Preview')).toBeVisible()

  await page.getByRole('textbox', { exact: true, name: 'Book title' }).fill('Edited Title')
  await page.getByRole('textbox', { exact: true, name: 'Author' }).fill('Edited Author')
  await page.getByRole('button', { name: 'Import Selected' }).click()

  await expect
    .poll(() => getImportedTextSelections(page))
    .toEqual([
      {
        path: filePath,
        encoding: 'utf-8',
        title: 'Edited Title',
        creator: 'Edited Author',
      },
    ])
})
