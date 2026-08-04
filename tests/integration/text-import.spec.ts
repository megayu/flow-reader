import path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import { getImportedTextSelections, getStoredSettings, installTauriMock } from '../support/tauri-mock'

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
