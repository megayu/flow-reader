import path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import {
  getBookImportOperations,
  getImportedTextSelections,
  getStoredSettings,
  installTauriMock,
} from '../support/tauri-mock'

const settingsShortcut = process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'
const selectAllShortcut = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'

async function openSettings(page: Page) {
  await page.keyboard.press(settingsShortcut)
  const dialog = page.getByRole('dialog', { name: msg('settings.title') })
  await expect(dialog).toBeVisible()
  return dialog
}

async function getStoredGroupPatterns(page: Page) {
  const settings = (await getStoredSettings(page)) as {
    textImportRules?: {
      groupPatterns?: string[]
    }
  }

  return settings.textImportRules?.groupPatterns ?? null
}

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

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.import_books') }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText(msg('text_import.title'))).toBeVisible()

  const titleInput = page.getByRole('textbox', { exact: true, name: msg('text_import.book_title') })
  await titleInput.selectText()
  await titleInput.fill('Edited Title')
  await page.getByRole('textbox', { exact: true, name: msg('text_import.creator') }).fill('Edited Author')
  await page.getByRole('button', { name: msg('text_import.import_selected') }).click()

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

test('direct mixed import prepares TXT alongside EPUB and commits it in one later phase', async ({ page }) => {
  const epubPath = path.join('tmp', 'First.epub')
  const textPath = path.join('tmp', 'Second.txt')

  await installTauriMock(page, {
    epubImportDelayMs: 150,
    importedBooks: [
      createTestBook({
        id: 'direct-epub-book',
        name: 'First.epub',
        sourceFormat: 'epub',
        metadata: { title: 'First' },
      }),
      createTestBook({
        id: 'direct-text-book',
        name: 'Second.txt',
        sourceFormat: 'txt',
        metadata: { title: 'Second' },
      }),
    ],
    openDialogPaths: [epubPath, textPath],
    settings: { directTextImport: true },
    textImportPreviewDelayMs: 20,
  })
  await page.goto('/')

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.import_books') }).click()

  await expect(page.getByText(msg('text_import.title'))).toBeHidden()
  await expect(page.getByRole('status')).toContainText('0 / 2')
  await expect.poll(() => getImportedTextSelections(page)).toEqual([{ path: textPath }])
  await expect
    .poll(() => getBookImportOperations(page))
    .toEqual([
      'txt-preview:start',
      'epub:start',
      'txt-preview:finish',
      'epub:finish',
      'txt-import:start',
      'txt-import:finish',
    ])
  await expect(page.getByRole('status').getByRole('heading')).toContainText('2')
})

test('preview confirmation keeps EPUB progress until the queued TXT import can start', async ({ page }) => {
  const epubPaths = [path.join('tmp', 'First.epub'), path.join('tmp', 'Second.epub')]
  const textPath = path.join('tmp', 'Third.txt')

  await installTauriMock(page, {
    eventListenDelayMs: 100,
    epubImportDelayMs: 1_000,
    importedBooks: [
      createTestBook({ id: 'first-epub', name: 'First.epub', sourceFormat: 'epub' }),
      createTestBook({ id: 'second-epub', name: 'Second.epub', sourceFormat: 'epub' }),
      createTestBook({ id: 'third-text', name: 'Third.txt', sourceFormat: 'txt' }),
    ],
    openDialogPaths: [...epubPaths, textPath],
    textImportDelayMs: 1_000,
  })
  await page.goto('/')

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.import_books') }).click()
  await expect(page.getByText(msg('text_import.title'))).toBeVisible()
  const importButton = page.getByRole('button', { name: msg('text_import.import_selected') })
  await expect(importButton).toBeEnabled()
  await expect.poll(() => getBookImportOperations(page)).toContain('epub:start')

  const progress = page
    .getByRole('status')
    .filter({ has: page.getByRole('heading', { name: msg('import.title.progress') }) })
  await expect(progress).toContainText('0 / 2')

  await importButton.dispatchEvent('click')

  await expect(progress).toContainText('0 / 2')
  await expect.poll(() => getBookImportOperations(page)).toContain('txt-import:start')
  await expect(progress).toContainText('0 / 1')
})

test('switches TXT import previews with arrow keys while keeping the active preview focused and visible', async ({
  page,
}) => {
  const previewCount = 18
  const filePaths = Array.from({ length: previewCount }, (_, index) => path.join('tmp', `Preview ${index + 1}.txt`))

  await installTauriMock(page, {
    openDialogPaths: filePaths,
    textImportPreviews: filePaths.map((filePath, index) => ({
      path: filePath,
      filename: path.basename(filePath),
      title: `Preview title ${index + 1}`,
      encoding: 'utf-8',
      encodingLabel: 'UTF-8',
      confidence: 'high' as const,
      status: 'ready' as const,
      selected: true,
      chapters: [],
      sample: '',
    })),
  })
  await page.goto('/')

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.import_books') }).click()
  const titleInput = page.getByRole('textbox', { exact: true, name: msg('text_import.book_title') })
  const firstPreview = page.getByRole('button', { name: /Preview 1\.txt/ })
  const lastPreview = page.getByRole('button', { name: new RegExp(`Preview ${previewCount}\\.txt`) })
  const previewList = page.locator('aside > .scroll')

  await expect(firstPreview).toBeFocused()
  await page.keyboard.press('ArrowUp')
  for (let index = 1; index < previewCount; index += 1) {
    await page.keyboard.press('ArrowDown')
  }
  await expect(titleInput).toHaveValue(`Preview title ${previewCount}`)
  await expect(lastPreview).toBeFocused()
  await expect.poll(() => previewList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('ArrowDown')
  await expect(lastPreview).toBeFocused()
})

test('TXT import rules preserve enter input and persist by line', async ({ page }) => {
  await installTauriMock(page)
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()

  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: msg('settings.tabs.txt') }).click()

  const groupRules = dialog.getByRole('textbox', {
    name: msg('settings.txt_import.group_rules'),
  })
  const previousGroupPatterns = await getStoredGroupPatterns(page)

  await groupRules.focus()
  await groupRules.press(selectAllShortcut)
  await groupRules.pressSequentially('^part$')
  await expect(groupRules).toHaveValue('^part$')
  await groupRules.press('Enter')
  await groupRules.pressSequentially('^book$')
  await expect(groupRules).toHaveValue('^part$\n^book$')
  await expect
    .poll(async () => {
      const box = await groupRules.boundingBox()
      return box ? Math.round(box.height) : 0
    })
    .toBeGreaterThanOrEqual(136)

  await expect
    .poll(async () => {
      return groupRules.evaluate((element) => {
        const style = getComputedStyle(element)
        return parseFloat(style.maxHeight) - parseFloat(style.minHeight)
      })
    })
    .toBeGreaterThanOrEqual(200)

  await page.waitForTimeout(350)
  await expect
    .poll(async () => {
      const settings = (await getStoredSettings(page)) as {
        textImportRules?: {
          groupPatterns?: string[]
        }
      }
      return settings.textImportRules?.groupPatterns ?? null
    })
    .toEqual(previousGroupPatterns)

  await dialog
    .getByRole('textbox', {
      name: msg('settings.txt_import.chapter_rules'),
    })
    .focus()

  await expect
    .poll(async () => {
      const settings = (await getStoredSettings(page)) as {
        textImportRules?: {
          groupPatterns?: string[]
        }
      }
      return settings.textImportRules?.groupPatterns
    })
    .toEqual(['^part$', '^book$'])
})
