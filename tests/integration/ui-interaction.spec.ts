import { expect, type Page, test } from '@playwright/test'

import { msg } from '../support/i18n'
import { getFullscreenState, getStoredSettings, installTauriMock } from '../support/tauri-mock'

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

test('restores a persisted sidebar width before the first visible frame without a hydration mismatch', async ({
  page,
}) => {
  const hydrationErrors: string[] = []

  await page.evaluate(() => {
    window.localStorage.setItem('flow-reader:sidebar:library:width', '276')
  })
  await page.addInitScript(() => {
    const frameWidths: number[] = []
    Object.assign(window, { __FLOW_TEST_SIDEBAR_FRAME_WIDTHS__: frameWidths })

    const sampleSidebarWidth = () => {
      const sidebar = document.querySelector('.SideBar')
      if (sidebar instanceof HTMLElement) {
        frameWidths.push(Math.round(Number.parseFloat(sidebar.style.width)))
      }
      window.requestAnimationFrame(sampleSidebarWidth)
    }
    window.requestAnimationFrame(sampleSidebarWidth)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrated|hydration mismatch/i.test(message.text())) {
      hydrationErrors.push(message.text())
    }
  })

  await page.reload()
  await expect(page.locator('#layout')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __FLOW_TEST_SIDEBAR_FRAME_WIDTHS__?: number[]
            }
          ).__FLOW_TEST_SIDEBAR_FRAME_WIDTHS__ ?? [],
      ),
    )
    .toContain(276)

  const frameWidths = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __FLOW_TEST_SIDEBAR_FRAME_WIDTHS__?: number[]
        }
      ).__FLOW_TEST_SIDEBAR_FRAME_WIDTHS__ ?? [],
  )
  const restoredFrame = frameWidths.indexOf(276)
  expect(restoredFrame).toBeGreaterThanOrEqual(0)
  expect(frameWidths.slice(restoredFrame)).toEqual(Array(frameWidths.length - restoredFrame).fill(276))
  expect(hydrationErrors).toEqual([])
})

test('loads without client exceptions and persists accent color settings', async ({ page }) => {
  const runtimeErrors: string[] = []

  page.on('pageerror', (error) => {
    runtimeErrors.push(error.stack || error.message)
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') return

    const text = message.text()
    if (
      /client-side exception/i.test(text) ||
      /ReactCurrentDispatcher/i.test(text) ||
      /Unhandled Runtime Error/i.test(text)
    ) {
      runtimeErrors.push(text)
    }
  })

  await page.reload()
  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.getByRole('button', { name: msg('settings.title') })).toBeVisible()
  expect(runtimeErrors).toEqual([])

  const dialog = await openSettings(page)
  await expect(dialog.getByText(msg('settings.title'))).toBeVisible()
  await expect(dialog.getByRole('heading', { name: msg('settings.tabs.basic') })).toBeVisible()
  await expect(dialog.getByText(msg('theme.source_color'))).toBeVisible()

  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await page.locator('.react-colorful').locator('..').getByRole('textbox').fill(accentColor)
  await page.getByRole('button', { name: msg('color_picker.apply') }).click()

  await expect(dialog.getByRole('button', { name: new RegExp(accentColor, 'i') })).toBeVisible()
  await expect.poll(() => getStoredAccentColor(page)).toBe(accentColor)

  await page.keyboard.press('Escape')
  await expect(page.locator('.react-colorful')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(runtimeErrors).toEqual([])
})

test('configures one shared main language, secondary language, and translation service', async ({ page }) => {
  const dialog = await openSettings(page)
  await dialog.getByRole('button', { name: msg('settings.tabs.translation'), exact: true }).click()

  await expect(dialog.getByRole('combobox', { name: msg('settings.translation.main_language') })).toContainText(
    '简体中文',
  )
  await expect(dialog.getByRole('combobox', { name: msg('settings.translation.secondary_language') })).toContainText(
    'English',
  )
  await expect(dialog.getByText(msg('settings.translation.default_provider'))).toBeVisible()
  await dialog.getByRole('combobox', { name: msg('settings.translation.main_language') }).click()
  await expect(page.getByRole('option')).toHaveText([
    '简体中文',
    'English',
    'Deutsch',
    'Español',
    'Français',
    'Italiano',
    'Nederlands',
    'Polski',
    'Português',
    'Русский',
    '日本語',
    '한국어',
    '繁體中文',
  ])
  await page.keyboard.press('Escape')
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
  const language = dialog.getByRole('combobox', { name: msg('settings.language') })
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

test('keeps original-file references opt-in and persists the import mode', async ({ page }) => {
  const dialog = await openSettings(page)
  const checkbox = dialog.getByRole('checkbox', {
    name: msg('settings.source_storage'),
  })

  await expect(checkbox).not.toBeChecked()
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
})

test('zen mode action is visibly disabled in library mode', async ({ page }) => {
  const zenButton = page.getByRole('button', {
    name: msg('zen.enter'),
  })

  await expect(zenButton).toBeVisible()
  await expect(zenButton).toBeDisabled()
  await expect(zenButton).not.toHaveAttribute('title', /.+/)
  await expect(zenButton).toHaveCSS('cursor', 'not-allowed')

  await zenButton.evaluate((button) => {
    ;(button as HTMLButtonElement).click()
  })

  await expect(page.locator('.ActivityBar')).toBeVisible()

  await zenButton.hover({ force: true })
  await expect(page.getByRole('tooltip')).toHaveCount(0)
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

test('disables browser autofill on app input controls', async ({ page }) => {
  const dialog = await openSettings(page)

  await dialog.getByRole('button', { name: msg('settings.tabs.txt') }).click()
  await dialog.getByRole('button', { name: msg('settings.tabs.basic') }).click()
  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await expect(page.locator('.react-colorful').locator('..').getByRole('textbox')).toBeVisible()

  const invalidControls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form, input, textarea'))
      .filter((element) => {
        if (element instanceof HTMLInputElement && element.type === 'hidden') {
          return false
        }

        if (element.getAttribute('autocomplete') !== 'off') return true

        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          return (
            element.getAttribute('autocorrect') !== 'off' ||
            element.getAttribute('autocapitalize') !== 'off' ||
            element.getAttribute('spellcheck') !== 'false'
          )
        }

        return false
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type:
          element instanceof HTMLInputElement
            ? element.type
            : element instanceof HTMLTextAreaElement
              ? 'textarea'
              : undefined,
        ariaLabel: element.getAttribute('aria-label'),
      }))
  })

  expect(invalidControls).toEqual([])
})

test('TXT import rules preserve enter input and persist by line', async ({ page }) => {
  const dialog = await openSettings(page)

  await dialog.getByRole('button', { name: msg('settings.tabs.txt') }).click()

  const groupRules = dialog.getByRole('textbox', {
    name: msg('settings.txt_import.group_rules'),
  })
  const previousGroupPatterns = await getStoredGroupPatterns(page)

  await groupRules.fill('^part$')
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

async function getStoredGroupPatterns(page: Page) {
  const settings = (await getStoredSettings(page)) as {
    textImportRules?: {
      groupPatterns?: string[]
    }
  }

  return settings.textImportRules?.groupPatterns ?? null
}
