import { expect, test, type Page } from '@playwright/test'

import {
  getFullscreenState,
  getStoredSettings,
  installTauriMock,
} from './tauri-mock'

const settingsShortcut =
  process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'
const commandKey = process.platform === 'darwin' ? 'Cmd' : 'Ctrl'
const accentColor = '#E11D48'

async function openSettings(page: Page) {
  await page.keyboard.press(settingsShortcut)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

async function readCssVariable(page: Page, name: string) {
  return page.evaluate((property) => {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(property)
      .trim()
  }, name)
}

async function normalizeCssColor(page: Page, value: string) {
  return page.evaluate((color) => {
    const el = document.createElement('div')
    el.style.color = color
    document.body.append(el)
    const normalized = getComputedStyle(el).color
    el.remove()
    return normalized
  }, value)
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto('/')
  await page.addStyleTag({
    content:
      'nextjs-portal{display:none!important;pointer-events:none!important}',
  })
  await expect(page.locator('#layout')).toBeVisible()
})

test('app UI font size changes app chrome without changing reading font size', async ({
  page,
}) => {
  const dialog = await openSettings(page)

  await expect
    .poll(() => readCssVariable(page, '--app-font-size-md'))
    .toBe('15px')

  const fontSizeInput = dialog.getByRole('textbox', {
    name: /App Font Size/,
  })
  const basicTab = dialog.getByRole('tab', { name: /Basic/ })

  await expect(fontSizeInput).toHaveValue('15')
  await fontSizeInput.focus()
  await page.keyboard.press('9')
  await expect(fontSizeInput).toHaveValue('15')

  await dialog.getByRole('button', { name: /App Font Size \+/ }).click()
  await dialog.getByRole('button', { name: /App Font Size \+/ }).click()

  await expect
    .poll(() => readCssVariable(page, '--app-font-size-md'))
    .toBe('17px')
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

test('action tooltips use styled content with separated shortcuts', async ({
  page,
}) => {
  const settingsButton = page.getByRole('button', { name: /Settings/ })

  await expect(settingsButton).toBeVisible()
  await expect(settingsButton).not.toHaveAttribute('title', /.+/)

  await settingsButton.hover()
  await expect(page.getByRole('tooltip')).toHaveCount(0, { timeout: 100 })

  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible({ timeout: 1000 })
  await expect(tooltip).toBeVisible()
  await expect(tooltip.getByText(/Settings/)).toBeVisible()
  await expect(tooltip.locator('kbd')).toContainText([commandKey, ','])
  await expect(tooltip).toHaveCSS('font-size', '15px')
  await expect(tooltip.locator('kbd').first()).toHaveCSS('font-size', '15px')
  await expect(tooltip).toHaveCSS('background-color', /rgb/)
  await expect(tooltip).toHaveCSS('user-select', 'none')
  await expect(
    tooltip.locator('[data-radix-popper-arrow-wrapper]'),
  ).toHaveCount(0)

  await page.mouse.move(200, 200)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
})

test('zen mode action is visibly disabled in library mode', async ({
  page,
}) => {
  const zenButton = page.getByRole('button', {
    name: /Enter Zen Mode/,
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

test('fullscreen shortcut works in library mode without an open tab', async ({
  page,
}) => {
  await expect(
    page.getByRole('button', { name: /Enter Fullscreen/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Return to Reading/ }),
  ).toBeDisabled()
  await expect.poll(() => getFullscreenState(page)).toBe(false)

  await page.keyboard.press('f')
  await expect.poll(() => getFullscreenState(page)).toBe(true)

  await page.keyboard.press('f')
  await expect.poll(() => getFullscreenState(page)).toBe(false)
})

test('accent color updates primary bridge and selected controls', async ({
  page,
}) => {
  const dialog = await openSettings(page)
  const selectedTab = dialog.getByRole('tab', { name: /Basic/ })
  const primaryBefore = await readCssVariable(page, '--primary')
  const accentBgBefore = await readCssVariable(page, '--flow-accent-bg')

  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await page.getByRole('textbox', { name: /Hex color/ }).fill(accentColor)
  await page.getByRole('button', { name: /Apply/ }).click()

  await expect
    .poll(() => readCssVariable(page, '--primary'))
    .not.toBe(primaryBefore)
  await expect
    .poll(() => readCssVariable(page, '--flow-accent-bg'))
    .not.toBe(accentBgBefore)

  const accentBgAfter = await readCssVariable(page, '--flow-accent-bg')
  const normalizedAccentBg = await normalizeCssColor(page, accentBgAfter)

  await expect(selectedTab).toHaveCSS('background-color', normalizedAccentBg)
})

test('theme color pickers close before the background theme panel on escape', async ({
  page,
}) => {
  await page.getByRole('button', { name: /Background Theme/ }).click()
  await expect(page.getByText(/Accent Color/)).toBeVisible()

  await page.getByRole('button', { name: /Accent Color/ }).click()
  await expect(page.getByRole('textbox', { name: /Hex color/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: /Hex color/ })).toBeHidden()
  await expect(page.getByText(/Accent Color/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Accent Color/)).toBeHidden()

  await page.getByRole('button', { name: /Background Theme/ }).click()
  await expect(page.getByText(/Accent Color/)).toBeVisible()

  await page.getByRole('button', { name: /Background Color/ }).click()
  await expect(page.getByRole('textbox', { name: /Hex color/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: /Hex color/ })).toBeHidden()
  await expect(page.getByText(/Accent Color/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(/Accent Color/)).toBeHidden()
})

test('disables browser autofill on app input controls', async ({ page }) => {
  const dialog = await openSettings(page)

  await dialog.getByRole('tab', { name: /TXT/ }).click()
  await dialog.getByRole('tab', { name: /Basic/ }).click()
  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await expect(page.getByRole('textbox', { name: /Hex color/ })).toBeVisible()

  const invalidControls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form, input, textarea'))
      .filter((element) => {
        if (element instanceof HTMLInputElement && element.type === 'hidden') {
          return false
        }

        if (element.getAttribute('autocomplete') !== 'off') return true

        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
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

test('TXT import rules preserve enter input and persist by line', async ({
  page,
}) => {
  const dialog = await openSettings(page)

  await dialog.getByRole('tab', { name: /TXT/ }).click()

  const groupRules = dialog.getByRole('textbox', {
    name: /Group rules/,
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
      name: /Chapter rules/,
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

test('settings shortcut list hides internal developer tools shortcut', async ({
  page,
}) => {
  const dialog = await openSettings(page)

  await dialog.getByRole('tab', { name: /Shortcuts/ }).click()

  await expect(dialog.getByText(/Developer Tools/)).toHaveCount(0)

  const shortcutText = (
    (await dialog.getByRole('tabpanel').textContent()) ?? ''
  ).replace(/\s+/g, '')

  expect(shortcutText).toMatch(/ClosealltabsCtrl\+Shift\+W/)
  expect(shortcutText).toMatch(/SwitchtoprevioustabCtrl\+←/)
  expect(shortcutText).toMatch(/SwitchtonexttabCtrl\+→/)
  expect(shortcutText).toMatch(/MovetableftCtrl\+Shift\+←/)
  expect(shortcutText).toMatch(/MovetabrightCtrl\+Shift\+→/)
  expect(shortcutText).toMatch(/Filterall.*`.*0/)
  expect(shortcutText).toMatch(/Clearfilters.*Esc/)
  expect(shortcutText).toMatch(/Filtertoread.*1/)
  expect(shortcutText).toMatch(/Filterreading.*2/)
  expect(shortcutText).toMatch(/Filterread.*3/)
})
