import { expect, test } from '@playwright/test'

import { getStoredSettings, installTauriMock } from './tauri-mock'

const testApiKey = 'test-only-mw-key'

async function openDictionarySettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Dictionary', exact: true }).click()
  return dialog
}

test('stores Merriam-Webster configuration locally with a masked key field', async ({
  page,
}) => {
  await installTauriMock(page)
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const enabled = dialog.getByRole('checkbox', {
    name: 'Enable Merriam-Webster',
  })
  await enabled.click()
  const keyInput = dialog.getByLabel('Merriam-Webster API key')
  await expect(keyInput).toHaveAttribute('type', 'password')
  await keyInput.fill(testApiKey)
  await keyInput.blur()

  await expect
    .poll(async () => {
      const stored = (await getStoredSettings(page)) as {
        dictionary?: {
          merriamWebster?: { apiKey?: string; enabled?: boolean }
        }
      }
      return stored.dictionary?.merriamWebster
    })
    .toEqual({ apiKey: testApiKey, enabled: true })

  await expect(keyInput).toHaveValue(testApiKey)
})

test('opens the official page for acquiring a Merriam-Webster API key', async ({
  page,
}) => {
  await installTauriMock(page)
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await dialog.getByRole('button', { name: 'Get a free API key' }).click()

  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const state = (
          window as typeof window & {
            __FLOW_TEST_TAURI__?: { openedExternalUrls: string[] }
          }
        ).__FLOW_TEST_TAURI__
        return state?.openedExternalUrls ?? []
      })
    })
    .toEqual(['https://dictionaryapi.com/'])
})
