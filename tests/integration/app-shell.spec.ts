import { expect, type Page, test } from '@playwright/test'

import { msg } from '../support/i18n'
import {
  clearSettingsOperations,
  getFullscreenState,
  getSettingsOperations,
  getStoredSettings,
  installTauriMock,
} from '../support/tauri-mock'

const settingsShortcut = process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'
const accentColor = '#E11D48'

async function openSettings(page: Page) {
  await page.keyboard.press(settingsShortcut)
  const dialog = page.getByRole('dialog', { name: msg('settings.title') })
  await expect(dialog).toBeVisible()
  return dialog
}

async function readCssVariable(page: Page, name: string) {
  return page.evaluate((property) => {
    return getComputedStyle(document.documentElement).getPropertyValue(property).trim()
  }, name)
}

async function getStoredAccentColor(page: Page) {
  const settings = (await getStoredSettings(page)) as {
    theme?: {
      accent?: string
    }
  }

  return settings.theme?.accent
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto('/')
  await expect(page.locator('#layout')).toBeVisible()
})

test('persists accent color settings', async ({ page }) => {
  const dialog = await openSettings(page)

  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await page.locator('.react-colorful').locator('..').getByRole('textbox').fill(accentColor)
  await page.getByRole('button', { name: msg('color_picker.apply') }).click()

  await expect(dialog.getByRole('button', { name: new RegExp(accentColor, 'i') })).toBeVisible()
  await expect.poll(() => getStoredAccentColor(page)).toBe(accentColor)

  await page.keyboard.press('Escape')
  await expect(page.locator('.react-colorful')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('persists the default translation service', async ({ page }) => {
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: msg('settings.tabs.translation'), exact: true }).click()

  await dialog.getByRole('button', { name: 'Azure', exact: true }).click()

  await expect
    .poll(async () => {
      const settings = (await getStoredSettings(page)) as {
        translation?: { defaultProvider?: string }
      }
      return settings.translation?.defaultProvider
    })
    .toBe('azure')
})

test('settings dropdown dismissal closes one layer at a time', async ({ page }) => {
  const dialog = await openSettings(page)
  const language = dialog.getByRole('combobox', { name: msg('language.title') })
  const options = page.locator('[data-slot="select-content"]')
  const headingBox = await dialog.getByRole('heading', { name: msg('settings.tabs.basic') }).boundingBox()
  if (!headingBox) throw new Error('Settings heading is not visible')

  await language.click()
  await expect(options).toBeVisible()
  await page.evaluate(() => new Promise(requestAnimationFrame))

  await page.mouse.click(headingBox.x + headingBox.width / 2, headingBox.y + headingBox.height / 2)
  await expect(options).toHaveCount(0)
  await expect(dialog).toBeVisible()

  await language.click()
  await expect(options).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(options).toHaveCount(0)
  await expect(dialog).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('settings close flushes only a changed session after its update', async ({ page }) => {
  let dialog = await openSettings(page)
  await clearSettingsOperations(page)
  await dialog.locator('[data-slot="dialog-close"]').click()
  await expect(dialog).toBeHidden()
  expect(await getSettingsOperations(page)).toEqual([])

  dialog = await openSettings(page)
  await dialog.getByRole('button', { name: msg('settings.tabs.storage') }).click()
  await dialog
    .getByRole('checkbox', {
      name: msg('settings.source_storage'),
    })
    .click()
  await expect.poll(() => getSettingsOperations(page)).toEqual(['update'])

  await dialog.locator('[data-slot="dialog-close"]').click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => getSettingsOperations(page)).toEqual(['update', 'flush'])
})

test('app UI font size changes app chrome without changing reading font size', async ({ page }) => {
  const dialog = await openSettings(page)

  await expect.poll(() => readCssVariable(page, '--app-font-size-md')).toBe('15px')

  const fontSizeInput = dialog.getByRole('textbox', {
    name: msg('settings.ui_font_size'),
  })
  const basicTab = dialog.getByRole('button', { name: msg('settings.tabs.basic') })

  await expect(fontSizeInput).toHaveValue('15')
  await fontSizeInput.focus()
  await page.keyboard.press('9')
  await expect(fontSizeInput).toHaveValue('15')

  await dialog.getByRole('button', { name: `${msg('settings.ui_font_size')} +` }).click()
  await dialog.getByRole('button', { name: `${msg('settings.ui_font_size')} +` }).click()

  await expect.poll(() => readCssVariable(page, '--app-font-size-md')).toBe('17px')
  await expect(basicTab).toHaveCSS('font-size', '17px')
  await expect
    .poll(async () => {
      const settings = (await getStoredSettings(page)) as {
        fontSize?: string
        ui?: {
          fontSize?: number
        }
      }

      return {
        readingFontSize: settings.fontSize ?? null,
        uiFontSize: settings.ui?.fontSize,
      }
    })
    .toEqual({
      readingFontSize: null,
      uiFontSize: 17,
    })
})

test('uses original-file references by default and persists the import mode', async ({ page }) => {
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: msg('settings.tabs.storage') }).click()
  const checkbox = dialog.getByRole('checkbox', {
    name: msg('settings.source_storage'),
  })

  await expect(checkbox).toBeChecked()
  await checkbox.click()
  await expect(checkbox).not.toBeChecked()
  await expect
    .poll(async () => {
      const settings = (await getStoredSettings(page)) as {
        importSourceStorage?: string
      }
      return settings.importSourceStorage
    })
    .toBe('managed')

  await checkbox.click()
  await expect(checkbox).toBeChecked()
  await expect
    .poll(async () => {
      const settings = (await getStoredSettings(page)) as {
        importSourceStorage?: string
      }
      return settings.importSourceStorage
    })
    .toBe('referenced')
})

test('keeps zen mode unavailable in library mode', async ({ page }) => {
  const zenButton = page.getByRole('button', {
    name: msg('zen.enter'),
  })

  await expect(zenButton).toBeVisible()
  await expect(zenButton).toBeDisabled()

  await zenButton.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
  })

  await expect(page.locator('.ActivityBar')).toBeVisible()
})

test('fullscreen shortcut works in library mode without an open tab', async ({ page }) => {
  await expect(page.getByRole('button', { name: msg('fullscreen.enter') })).toBeVisible()
  await expect(page.getByRole('button', { name: msg('mode.resume_reading') })).toBeDisabled()
  await expect.poll(() => getFullscreenState(page)).toBe(false)

  await page.keyboard.press('f')
  await expect.poll(() => getFullscreenState(page)).toBe(true)

  await page.keyboard.press('f')
  await expect.poll(() => getFullscreenState(page)).toBe(false)
})

test('theme color pickers close before the background theme panel on escape', async ({ page }) => {
  await page.getByRole('button', { name: msg('theme.title') }).click()
  await expect(page.getByText(msg('theme.source_color'))).toBeVisible()

  await page.getByRole('button', { name: msg('theme.source_color') }).click()
  await expect(page.locator('.react-colorful').locator('..').getByRole('textbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.react-colorful').locator('..').getByRole('textbox')).toBeHidden()
  await expect(page.getByText(msg('theme.source_color'))).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(msg('theme.source_color'))).toBeHidden()

  await page.getByRole('button', { name: msg('theme.title') }).click()
  await expect(page.getByText(msg('theme.source_color'))).toBeVisible()

  await page
    .locator('[data-flow-theme-panel]')
    .getByRole('button', { name: msg('theme.preset.custom') })
    .click()
  await expect(page.locator('.react-colorful').locator('..').getByRole('textbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.react-colorful').locator('..').getByRole('textbox')).toBeHidden()
  await expect(page.getByText(msg('theme.source_color'))).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(msg('theme.source_color'))).toBeHidden()
})
