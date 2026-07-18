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

test('configures Merriam-Webster inline with the key actions in one row', async ({
  page,
}) => {
  await installTauriMock(page)
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const source = dialog.locator('[data-dictionary-source-id="merriam-webster"]')
  const enabled = source.getByRole('checkbox')
  const edit = source.getByRole('button').first()
  await expect(enabled).toBeDisabled()
  await edit.click()
  await expect(edit.locator('.lucide-check')).toBeVisible()
  await source.locator('[data-merriam-webster-key-row] input').press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-merriam-webster-key-row]')).toHaveCount(0)

  await edit.click()
  const keyInput = source.locator('[data-merriam-webster-key-row] input')
  await expect(keyInput).toHaveAttribute('type', 'password')
  const keyRow = dialog.locator('[data-merriam-webster-key-row]')
  const visibility = keyRow.getByRole('button').first()
  const getKey = keyRow.getByRole('button', { name: 'Get a free API key' })
  const [inputBox, visibilityBox, getKeyBox] = await Promise.all([
    keyInput.boundingBox(),
    visibility.boundingBox(),
    getKey.boundingBox(),
  ])
  expect(inputBox).not.toBeNull()
  expect(visibilityBox).not.toBeNull()
  expect(getKeyBox).not.toBeNull()
  expect(visibilityBox!.x).toBeGreaterThan(inputBox!.x)
  expect(visibilityBox!.x + visibilityBox!.width).toBeLessThanOrEqual(
    inputBox!.x + inputBox!.width,
  )
  expect(Math.abs(getKeyBox!.y - inputBox!.y)).toBeLessThan(2)
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
  await expect(
    source.locator('[data-merriam-webster-key-row] input'),
  ).toHaveValue(testApiKey)
})

test('shows every dictionary source in one reorderable persisted list', async ({
  page,
}) => {
  const local = localDictionary({
    id: 'dict-unified00000000000',
    name: 'Fixture Lexicon',
    sourcePath: 'fixture-' + 'dictionary-segment'.repeat(40) + '.mdx',
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

  await expect(sources).toHaveCount(3)
  await expect(sources.nth(0)).toContainText('汉典')
  await expect(sources.nth(0)).toContainText('Online')
  await expect(sources.nth(0)).toContainText('中文')
  await expect(sources.nth(1)).toContainText('Merriam-Webster')
  await expect(sources.nth(1)).toContainText('Online')
  await expect(sources.nth(2)).toContainText('Fixture Lexicon')

  const sidebar = dialog.locator('aside')
  const content = dialog.locator('section').first()
  const [dialogBox, sidebarBox, contentBox] = await Promise.all([
    dialog.boundingBox(),
    sidebar.boundingBox(),
    content.boundingBox(),
  ])
  expect(dialogBox).not.toBeNull()
  expect(sidebarBox).not.toBeNull()
  expect(contentBox).not.toBeNull()
  expect(sidebarBox!.x).toBeGreaterThanOrEqual(dialogBox!.x)
  expect(contentBox!.x).toBeGreaterThanOrEqual(
    sidebarBox!.x + sidebarBox!.width - 1,
  )
  expect(contentBox!.x + contentBox!.width).toBeLessThanOrEqual(
    dialogBox!.x + dialogBox!.width + 1,
  )
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true)

  const target = sources.nth(2)
  const handle = sources.nth(0).locator('[data-dictionary-drag-handle]')
  const handleBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height - 2,
    { steps: 6 },
  )
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

test('opens the official page for acquiring a Merriam-Webster API key', async ({
  page,
}) => {
  await installTauriMock(page)
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await dialog
    .locator('[data-dictionary-source-id="merriam-webster"]')
    .getByRole('button')
    .first()
    .click()
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
  await expect(dialog.getByText('Source unavailable')).toBeVisible()
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
    Math.max(...firstLanguageRow.map((box) => box!.y)) -
      Math.min(...firstLanguageRow.map((box) => box!.y)),
  ).toBeLessThan(2)
  expect(
    await alphaRow.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true)
  const chinese = alphaRow.getByRole('checkbox', { name: '中文' })
  const english = alphaRow.getByRole('checkbox', { name: 'English' })
  await chinese.click()
  await expect(chinese).toBeChecked()
  await english.click()
  await expect(english).toBeChecked()
  await expect(alphaRow.getByText(/^中文, English ·/)).toBeVisible()
  expect(
    (await getLocalDictionaryMockState(page)).localDictionaries.find(
      (dictionary) => dictionary.id === alpha.id,
    )?.language,
  ).toEqual({ source: 'unknown', value: [] })
  await alphaEdit.click()
  await expect(alphaToggle).toBeEnabled()
  await alphaToggle.click()
  await alphaEdit.click()
  await alphaRow.getByRole('button').nth(1).click()

  await expect
    .poll(async () => {
      const state = await getLocalDictionaryMockState(page)
      const current = state.localDictionaries.find(
        (dictionary) => dictionary.id === alpha.id,
      )
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
  expect(
    (await getLocalDictionaryMockState(page)).localDictionaries,
  ).toHaveLength(1)
})

test('renames a local dictionary inline and hides language provenance', async ({
  page,
}) => {
  const dictionary = localDictionary({
    id: 'dict-renameable000000000',
    name: 'Fixture Lexicon',
    sourcePath: 'fixture-dictionary.mdx',
  })
  await installTauriMock(page, { localDictionaries: [dictionary] })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  const row = dialog.locator(`[data-local-dictionary-id="${dictionary.id}"]`)

  await expect(row.getByText('Language source')).toHaveCount(0)
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
      return state.localDictionaries.find(
        (record) => record.id === dictionary.id,
      )?.name
    })
    .toBe('Reader Lexicon')
})

test('cancels an inline dictionary rename with Escape without closing settings', async ({
  page,
}) => {
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

test('dismisses open settings dropdowns before closing settings', async ({
  page,
}) => {
  const dictionary = localDictionary({
    id: 'dict-dropdown0000000000',
    name: 'Fixture Lexicon',
    sourcePath: 'fixture-dictionary.mdx',
  })
  await installTauriMock(page, { localDictionaries: [dictionary] })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)
  await dialog.getByRole('button', { name: 'Basic', exact: true }).click()

  await dialog.getByRole('combobox', { name: 'Language' }).click()
  const options = page.locator('[data-slot="select-content"]')
  await expect(options).toBeVisible()
  await page.mouse.click(4, 4)

  await expect(options).toHaveCount(0)
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Dictionary', exact: true }).click()
  const row = dialog.locator(`[data-local-dictionary-id="${dictionary.id}"]`)
  await row.getByRole('button').first().click()
  await row.locator('input').first().fill('Draft name')
  await dialog.getByText('Dictionary sources').click()
  await expect(row.locator('input').first()).toHaveCount(0)
  await expect(dialog).toBeVisible()
})

test('shows master-file validation errors without adding a partial record', async ({
  page,
}) => {
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
  await dialog.getByRole('button', { name: 'Add local dictionary' }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    'Choose a StarDict .ifo or MDict .mdx master file.',
  )
  expect((await getLocalDictionaryMockState(page)).localDictionaries).toEqual(
    [],
  )
})

test('displays native Windows and Unix dictionary paths without changing stored paths', async ({
  page,
}) => {
  const windowsExtended =
    '\\\\?\\C:\\Users\\reader\\Dictionaries\\Oxford\\oxford.ifo'
  const windowsUnc =
    '\\\\?\\UNC\\dictionary-server\\shared\\Chinese\\source.mdx'
  const unix = '/home/reader/dictionaries/english/source.ifo'
  await installTauriMock(page, {
    localDictionaries: [
      localDictionary({
        id: 'dict-11111111111111111111',
        name: 'Windows Dictionary',
        sourcePath: windowsExtended,
      }),
      localDictionary({
        id: 'dict-22222222222222222222',
        name: 'UNC Dictionary',
        order: 1,
        sourcePath: windowsUnc,
      }),
      localDictionary({
        id: 'dict-33333333333333333333',
        name: 'Unix Dictionary',
        order: 2,
        sourcePath: unix,
      }),
    ],
  })
  await page.goto('/')
  const dialog = await openDictionarySettings(page)

  const expected = [
    [
      'dict-11111111111111111111',
      'C:\\Users\\reader\\Dictionaries\\Oxford\\oxford.ifo',
    ],
    [
      'dict-22222222222222222222',
      '\\\\dictionary-server\\shared\\Chinese\\source.mdx',
    ],
    ['dict-33333333333333333333', unix],
  ] as const
  for (const [id, path] of expected) {
    const row = dialog.locator(`[data-local-dictionary-id="${id}"]`)
    await expect(row.getByText(path, { exact: false })).toBeVisible()
  }

  const stored = await getLocalDictionaryMockState(page)
  expect(
    stored.localDictionaries.map((dictionary) => dictionary.sourcePath),
  ).toEqual([windowsExtended, windowsUnc, unix])
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
    language: { source: 'unknown', value: [] },
    order: 0,
    sourceStatus: 'available',
    updatedAt: 1,
    ...overrides,
  }
}
