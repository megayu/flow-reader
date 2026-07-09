import path from 'node:path'

import { expect, test } from '@playwright/test'

import { getExportedBooks, installTauriMock } from './tauri-mock'

test('TXT book context menu exports TXT and EPUB with per-format dirty markers', async ({
  page,
}) => {
  const outputPath = path.join('tmp', 'Correctable.txt')

  await installTauriMock(page, {
    books: [
      {
        id: 'txt-book',
        name: 'Correctable.txt',
        size: 1024,
        sourceFormat: 'txt',
        exportedVersions: {
          txt: 1,
          epub: 2,
        },
        contentEditedAt: 123,
        contentHash: 'hash',
        contentVersion: 2,
        metadata: {
          title: 'Correctable',
        },
        createdAt: 1,
        definitions: [],
        annotations: [],
      },
    ],
    saveDialogPath: outputPath,
  })
  await page.goto('/')
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })

  await expect(page.getByText('Correctable')).toBeVisible()
  await page.getByText('Correctable').click({ button: 'right' })

  const exportTxtMenuItem = page.getByRole('menuitem', {
    name: /Export TXT\s*\*/,
  })
  await expect(exportTxtMenuItem).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Export EPUB' }),
  ).toBeVisible()

  await exportTxtMenuItem.click()
  await expect
    .poll(() => getExportedBooks(page))
    .toEqual([
      {
        id: 'txt-book',
        format: 'txt',
        outputPath,
      },
    ])

  await page.getByText('Correctable').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Export TXT' })).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Export EPUB' }),
  ).toBeVisible()
})
