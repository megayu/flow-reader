import { expect, test } from '@playwright/test'

import type { LocalDictionaryRecord } from '../../src/dictionary/native'
import { msg } from '../support/i18n'
import { getLocalDictionaryMockState, getStoredSettings, installTauriMock } from '../support/tauri-mock'

const testApiKey = 'test-only-mw-key'

async function openDictionarySettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: msg('settings.title') }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: msg('dictionary.title'), exact: true }).click()
  return dialog
}

test('persists Merriam-Webster credentials and enablement', async ({ page }) => {
  await installTauriMock(page)
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const source = dialog.locator('[data-dictionary-source-id="merriam-webster"]')
  const enabled = source.getByRole('checkbox')
  const edit = source.getByRole('button').first()
  await expect(enabled).toBeDisabled()
  await edit.click()
  await source.locator('[data-merriam-webster-key-row] input').press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-merriam-webster-key-row]')).toHaveCount(0)

  await edit.click()
  const keyInput = source.locator('[data-merriam-webster-key-row] input')
  const keyRow = dialog.locator('[data-merriam-webster-key-row]')
  await keyInput.fill(testApiKey)
  await edit.click()
  await expect(keyRow).toHaveCount(0)
  await expect(enabled).toBeEnabled()
  await enabled.click()

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

  await edit.click()
  await expect(source.locator('[data-merriam-webster-key-row] input')).toHaveValue(testApiKey)
})

test('persists reordered dictionary sources', async ({ page }) => {
  const local = localDictionary({
    id: 'dict-unified00000000000',
    name: 'Fixture Lexicon',
    sourcePath: `fixture-${'dictionary-segment'.repeat(40)}.mdx`,
    language: {
      source: 'manual',
      value: ['zh', 'en', 'ru', 'fr', 'de', 'es', 'pt', 'it'],
    },
  })
  await installTauriMock(page, {
    localDictionaries: [local],
    settings: { ui: { fontSize: 18 } },
  })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const sources = dialog.locator('[data-dictionary-source-id]')

  const target = sources.nth(2)
  const handle = sources.nth(0).locator('[data-dictionary-drag-handle]')
  const handleBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height - 2, { steps: 6 })
  await page.mouse.up()

  await expect
    .poll(async () => {
      const stored = (await getStoredSettings(page)) as {
        dictionary?: { sourceOrder?: string[] }
      }
      return stored.dictionary?.sourceOrder
    })
    .toEqual(['merriam-webster', `local:${local.id}`, 'zdic'])
})

test('adds one local dictionary from an ifo or mdx master-file chooser', async ({ page }) => {
  const sourcePath = 'fixture-oxford.ifo'
  const record = localDictionary({
    id: 'dict-11111111111111111111',
    name: 'Oxford Test',
    sourcePath,
  })
  await installTauriMock(page, {
    openDialogPaths: [sourcePath],
    localDictionaryFiles: { [sourcePath]: record },
  })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await dialog.getByRole('button', { name: msg('settings.dictionary.local_add') }).click()

  await expect(dialog.getByText('Oxford Test')).toBeVisible()
  const state = await getLocalDictionaryMockState(page)
  expect(state.localDictionaries).toHaveLength(1)
  expect(JSON.stringify(state.dialogOpenCalls)).toContain('ifo')
  expect(JSON.stringify(state.dialogOpenCalls)).toContain('mdx')
  expect(JSON.stringify(state.dialogOpenCalls)).toContain('"directory":false')
  expect(JSON.stringify(state.dialogOpenCalls)).not.toContain('idx')
})

test('manages local dictionary order, status, language, enablement, relocation, and removal', async ({ page }) => {
  const alpha = localDictionary({
    id: 'dict-aaaaaaaaaaaaaaaaaaaa',
    name: 'Alpha Dictionary',
    sourcePath: 'fixture-alpha.mdx',
  })
  const beta = localDictionary({
    id: 'dict-bbbbbbbbbbbbbbbbbbbb',
    name: 'Beta Dictionary',
    order: 1,
    sourcePath: 'fixture-beta.ifo',
    sourceStatus: 'missing',
  })
  await installTauriMock(page, {
    localDictionaries: [alpha, beta],
    localDictionaryFiles: { [alpha.sourcePath]: alpha },
    openDialogPaths: [alpha.sourcePath],
  })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await expect(dialog.getByText(msg('settings.dictionary.local_status.missing'))).toBeVisible()
  await expect(dialog.getByText('Available', { exact: true })).toHaveCount(0)

  const alphaRow = dialog.locator(`[data-local-dictionary-id="${alpha.id}"]`)
  const alphaToggle = alphaRow.getByRole('checkbox').first()
  const alphaEdit = alphaRow.getByRole('button').first()
  await expect(alphaToggle).toBeDisabled()
  await alphaEdit.click()
  const firstLanguageRow = await Promise.all(
    ['中文', 'English', 'Русский', 'Français'].map((language) =>
      alphaRow.getByText(language, { exact: true }).boundingBox(),
    ),
  )
  expect(firstLanguageRow.every(Boolean)).toBe(true)
  expect(
    Math.max(...firstLanguageRow.map((box) => box!.y)) - Math.min(...firstLanguageRow.map((box) => box!.y)),
  ).toBeLessThan(2)
  expect(await alphaRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const chinese = alphaRow.getByRole('checkbox', { name: '中文' })
  const english = alphaRow.getByRole('checkbox', { name: 'English' })
  await chinese.click()
  await expect(chinese).toBeChecked()
  await english.click()
  await expect(english).toBeChecked()
  await expect(alphaRow.getByText(/^中文, English ·/)).toBeVisible()
  expect(
    (await getLocalDictionaryMockState(page)).localDictionaries.find((dictionary) => dictionary.id === alpha.id)
      ?.language,
  ).toEqual({ source: 'unknown', value: [] })
  await alphaEdit.click()
  await expect(alphaToggle).toBeEnabled()
  await alphaToggle.click()
  await alphaEdit.click()
  await alphaRow.getByRole('button').nth(1).click()

  await expect
    .poll(async () => {
      const state = await getLocalDictionaryMockState(page)
      const current = state.localDictionaries.find((dictionary) => dictionary.id === alpha.id)
      return {
        enabled: current?.enabled,
        language: current?.language,
      }
    })
    .toEqual({
      enabled: false,
      language: { source: 'manual', value: ['zh', 'en'] },
    })

  const betaRow = dialog.locator(`[data-local-dictionary-id="${beta.id}"]`)
  await betaRow.getByRole('button').first().click()
  const confirmRemove = betaRow.getByRole('button').nth(2)
  await confirmRemove.click()
  await expect(confirmRemove).toHaveAttribute('data-variant', 'destructive')
  await expect(confirmRemove.locator('.lucide-check')).toBeVisible()
  await confirmRemove.click()
  await expect(dialog.getByText('Beta Dictionary')).toHaveCount(0)
  expect((await getLocalDictionaryMockState(page)).localDictionaries).toHaveLength(1)
})

test('trims and persists an inline local dictionary rename', async ({ page }) => {
  const dictionary = localDictionary({
    id: 'dict-renameable000000000',
    name: 'Fixture Lexicon',
    sourcePath: 'fixture-dictionary.mdx',
  })
  await installTauriMock(page, { localDictionaries: [dictionary] })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const row = dialog.locator(`[data-local-dictionary-id="${dictionary.id}"]`)

  const edit = row.getByRole('button').first()
  await edit.click()
  const input = row.locator('input').first()
  await input.fill('  Reader Lexicon  ')
  await edit.click()

  await expect(input).toHaveCount(0)
  await expect(row.getByText('Reader Lexicon', { exact: true })).toBeVisible()
  await expect
    .poll(async () => {
      const state = await getLocalDictionaryMockState(page)
      return state.localDictionaries.find((record) => record.id === dictionary.id)?.name
    })
    .toBe('Reader Lexicon')
})

test('cancels an inline dictionary rename with Escape without closing settings', async ({ page }) => {
  const dictionary = localDictionary({
    id: 'dict-cancel-rename000000',
    name: 'Fixture Lexicon',
    sourcePath: 'fixture-dictionary.mdx',
  })
  await installTauriMock(page, { localDictionaries: [dictionary] })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const row = dialog.locator(`[data-local-dictionary-id="${dictionary.id}"]`)

  await row.getByRole('button').first().click()
  const input = row.locator('input').first()
  await input.fill('Changed name')
  await row.getByRole('checkbox', { name: 'English' }).click()
  await input.press('Escape')

  await expect(dialog).toBeVisible()
  await expect(input).toHaveCount(0)
  await expect(row.getByText('Fixture Lexicon', { exact: true })).toBeVisible()
  const stored = (await getLocalDictionaryMockState(page)).localDictionaries[0]
  expect(stored?.name).toBe('Fixture Lexicon')
  expect(stored?.language).toEqual({ source: 'unknown', value: [] })
})

test('shows master-file validation errors without adding a partial record', async ({ page }) => {
  const sourcePath = 'fixture-broken.idx'
  await installTauriMock(page, {
    openDialogPaths: [sourcePath],
    localDictionaryFiles: {
      [sourcePath]: {
        code: 'unsupportedMasterFile',
        message: 'Choose a StarDict .ifo or MDict .mdx master file.',
      },
    },
  })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await dialog.getByRole('button', { name: msg('settings.dictionary.local_add') }).click()
  await expect(dialog.getByRole('alert')).toContainText('Choose a StarDict .ifo or MDict .mdx master file.')
  expect((await getLocalDictionaryMockState(page)).localDictionaries).toEqual([])
})

function localDictionary(
  overrides: Partial<LocalDictionaryRecord> & Pick<LocalDictionaryRecord, 'id' | 'name' | 'sourcePath'>,
): LocalDictionaryRecord {
  return {
    createdAt: 1,
    enabled: true,
    fingerprint: { modifiedMs: 1, sampleHash: 'fixture', size: 1 },
    format: 'mdict',
    language: { source: 'unknown', value: [] },
    order: 0,
    sourceStatus: 'available',
    updatedAt: 1,
    ...overrides,
  }
}
