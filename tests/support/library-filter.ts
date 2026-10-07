import { expect, type Page } from '@playwright/test'

import { msg } from './i18n'

export async function openLibraryFilterPanel(page: Page) {
  const panel = page.getByTestId('library-filter-panel')

  if (!(await panel.isVisible())) {
    await page.getByRole('button', { name: msg('library_filter.title') }).click()
  }

  await expect(panel).toBeVisible()
}
