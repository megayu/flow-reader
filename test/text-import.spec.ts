import { expect, test } from '@playwright/test'

import { getImportedTextSelections, installTauriMock } from './tauri-mock'

test('TXT import dialog sends edited title and author metadata', async ({
  page,
}) => {
  const path = 'C:/tmp/Original Title.txt'

  await installTauriMock(page, {
    importedBooks: [
      {
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
      },
    ],
    openDialogPaths: [path],
    textImportPreviews: [
      {
        path,
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
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })

  await page.getByRole('button', { name: 'Import' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('TXT Import Preview')).toBeVisible()

  const previewGrid = page.getByTestId('text-import-preview-grid')
  const chapterPreview = previewGrid.locator('section').first()
  const resizeHandle = page.getByRole('button', {
    name: 'Chapter Preview / Text Preview',
  })
  const beforeDrag = await chapterPreview.boundingBox()
  const handleBox = await resizeHandle.boundingBox()
  expect(beforeDrag).not.toBeNull()
  expect(handleBox).not.toBeNull()
  if (!beforeDrag || !handleBox) return

  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    handleBox.x + handleBox.width / 2 + 80,
    handleBox.y + handleBox.height / 2,
  )
  await page.mouse.up()
  const afterDrag = await chapterPreview.boundingBox()
  expect(afterDrag?.width).toBeGreaterThan(beforeDrag.width + 30)

  await page
    .getByRole('textbox', { exact: true, name: 'Book title' })
    .fill('Edited Title')
  await page
    .getByRole('textbox', { exact: true, name: 'Author' })
    .fill('Edited Author')
  await page.getByRole('button', { name: 'Import Selected' }).click()

  await expect
    .poll(() => getImportedTextSelections(page))
    .toEqual([
      {
        path,
        encoding: 'utf-8',
        title: 'Edited Title',
        creator: 'Edited Author',
      },
    ])
})
