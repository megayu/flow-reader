import { expect, test, type Page } from '@playwright/test'

import { getStoredSettings, installTauriMock } from './tauri-mock'

const settingsShortcut =
  process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'
const accentColor = '#E11D48'

async function getStoredAccentColor(page: Page) {
  const settings = (await getStoredSettings(page)) as {
    theme?: {
      accent?: string
    }
  }

  return settings.theme?.accent
}

test('restores a persisted sidebar width before the first visible frame without a hydration mismatch', async ({
  page,
}) => {
  const hydrationErrors: string[] = []

  await installTauriMock(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('flow-reader:sidebar:library:width', '276')

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
    if (
      message.type() === 'error' &&
      /hydrated|hydration mismatch/i.test(message.text())
    ) {
      hydrationErrors.push(message.text())
    }
  })

  await page.goto('/')
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
  expect(frameWidths.slice(restoredFrame)).toEqual(
    Array(frameWidths.length - restoredFrame).fill(276),
  )
  expect(hydrationErrors).toEqual([])
})

test('loads without client exceptions and persists accent color settings', async ({
  page,
}) => {
  const runtimeErrors: string[] = []

  await installTauriMock(page)

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

  await page.goto('/')

  await expect(page.locator('#layout')).toBeVisible()
  await expect(page.getByRole('button', { name: /Settings/ })).toBeVisible()
  expect(runtimeErrors).toEqual([])

  await page.keyboard.press(settingsShortcut)

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/Settings/)).toBeVisible()
  await expect(dialog.getByRole('heading', { name: /Basic/ })).toBeVisible()
  await expect(dialog.getByText(/Accent Color/)).toBeVisible()

  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await page
    .locator('.react-colorful')
    .locator('..')
    .getByRole('textbox')
    .fill(accentColor)
  await page.getByRole('button', { name: /Apply/ }).click()

  await expect(
    dialog.getByRole('button', { name: new RegExp(accentColor, 'i') }),
  ).toBeVisible()
  await expect.poll(() => getStoredAccentColor(page)).toBe(accentColor)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  expect(runtimeErrors).toEqual([])
})
