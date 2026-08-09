import { expect, type Page } from '@playwright/test'

import { msg } from './i18n'

export async function openLibraryFilterPanel(page: Page) {
  const panel = page.getByTestId('library-filter-panel')

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await panel.isVisible()) return

    await page.getByRole('button', { name: msg('home.library_filter.title') }).click()
    await page.waitForTimeout(100)
  }

  await expect(panel).toBeVisible()
}
