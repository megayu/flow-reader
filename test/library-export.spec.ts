import { expect, test } from '@playwright/test'

import { getExportedBooks, installTauriMock } from './tauri-mock'

test('TXT book context menu exports TXT and EPUB with per-format dirty markers', async ({
  page,
}) => {
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
    saveDialogPath: 'C:/tmp/Correctable.txt',
  })
  await page.goto('/')
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })

  await expect(page.getByText('Correctable')).toBeVisible()
  await page.getByText('Correctable').click({ button: 'right' })

  await expect(
    page.getByRole('menuitem', { name: 'Export TXT*' }),
  ).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Export EPUB' }),
  ).toBeVisible()

  await page.getByRole('menuitem', { name: 'Export TXT*' }).click()
  await expect
    .poll(() => getExportedBooks(page))
    .toEqual([
      {
        id: 'txt-book',
        format: 'txt',
        outputPath: 'C:/tmp/Correctable.txt',
      },
    ])

  await page.getByText('Correctable').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Export TXT' })).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Export EPUB' }),
  ).toBeVisible()
})
