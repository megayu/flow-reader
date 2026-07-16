import { expect, test } from '@playwright/test'

import type { LocalDictionaryRecord } from '../src/dictionary/native'

import {
  getLocalDictionaryMockState,
  getStoredSettings,
  installTauriMock,
} from './tauri-mock'

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

test('adds one local dictionary from an ifo or mdx master-file chooser', async ({
  page,
}) => {
  const sourcePath = 'C:\\Dictionaries\\Oxford\\oxford.ifo'
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
  await dialog.getByRole('button', { name: 'Add local dictionary' }).click()

  await expect(dialog.getByText('Oxford Test')).toBeVisible()
  const state = await getLocalDictionaryMockState(page)
  expect(state.localDictionaries).toHaveLength(1)
  expect(JSON.stringify(state.dialogOpenCalls)).toContain('ifo')
  expect(JSON.stringify(state.dialogOpenCalls)).toContain('mdx')
  expect(JSON.stringify(state.dialogOpenCalls)).toContain('"directory":false')
  expect(JSON.stringify(state.dialogOpenCalls)).not.toContain('idx')
})

test('manages local dictionary order, status, language, enablement, relocation, and removal', async ({
  page,
}) => {
  const alpha = localDictionary({
    id: 'dict-aaaaaaaaaaaaaaaaaaaa',
    name: 'Alpha Dictionary',
    sourcePath: 'C:\\Dictionaries\\Alpha\\alpha.mdx',
  })
  const beta = localDictionary({
    id: 'dict-bbbbbbbbbbbbbbbbbbbb',
    name: 'Beta Dictionary',
    order: 1,
    sourcePath: 'C:\\Dictionaries\\Beta\\beta.ifo',
    sourceStatus: 'missing',
  })
  await installTauriMock(page, {
    localDictionaries: [alpha, beta],
    localDictionaryFiles: { [alpha.sourcePath]: alpha },
    openDialogPaths: [alpha.sourcePath],
  })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await expect(dialog.getByText('Source unavailable')).toBeVisible()

  await dialog
    .getByRole('checkbox', { name: 'Enable Alpha Dictionary' })
    .click()
  await dialog
    .getByRole('combobox', { name: 'Language Alpha Dictionary' })
    .click()
  await page.getByRole('option', { name: 'Chinese' }).click()
  await dialog
    .getByRole('button', { name: 'Move down Alpha Dictionary' })
    .click()
  await dialog
    .getByRole('button', { name: 'Relocate Alpha Dictionary' })
    .click()

  await expect
    .poll(async () => {
      const state = await getLocalDictionaryMockState(page)
      const current = state.localDictionaries.find(
        (dictionary) => dictionary.id === alpha.id,
      )
      return {
        enabled: current?.enabled,
        language: current?.language,
        order: current?.order,
      }
    })
    .toEqual({
      enabled: false,
      language: { source: 'manual', value: 'zh' },
      order: 1,
    })

  await dialog.getByRole('button', { name: 'Remove Beta Dictionary' }).click()
  await dialog
    .getByRole('button', { name: 'Confirm remove Beta Dictionary' })
    .click()
  await expect(dialog.getByText('Beta Dictionary')).toHaveCount(0)
  expect(
    (await getLocalDictionaryMockState(page)).localDictionaries,
  ).toHaveLength(1)
})

test('shows master-file validation errors without adding a partial record', async ({
  page,
}) => {
  const sourcePath = 'C:\\Dictionaries\\broken.idx'
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
  await dialog.getByRole('button', { name: 'Add local dictionary' }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    'Choose a StarDict .ifo or MDict .mdx master file.',
  )
  expect((await getLocalDictionaryMockState(page)).localDictionaries).toEqual(
    [],
  )
})

function localDictionary(
  overrides: Partial<LocalDictionaryRecord> &
    Pick<LocalDictionaryRecord, 'id' | 'name' | 'sourcePath'>,
): LocalDictionaryRecord {
  return {
    createdAt: 1,
    enabled: true,
    files: [],
    fingerprint: { modifiedMs: 1, sampleHash: 'fixture', size: 1 },
    format: 'mdict',
    language: { source: 'unknown', value: 'unknown' },
    order: 0,
    sourceStatus: 'available',
    updatedAt: 1,
    ...overrides,
  }
}
