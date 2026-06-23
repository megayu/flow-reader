import { expect, test, type Page } from '@playwright/test'

const settingsButtonSelector = 'button[title="Settings"], button[title="设置"]'
const settingsShortcut =
  process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'
const sourceColor = '#E11D48'

async function installTauriMock(page: Page) {
  await page.addInitScript(() => {
    type TauriInternals = {
      callbacks?: Record<number, (...args: unknown[]) => unknown>
      convertFileSrc?: (filePath: string) => string
      invoke?: (command: string, args?: Record<string, unknown>) => unknown
      metadata?: {
        currentWebview: { label: string }
        currentWindow: { label: string }
      }
      runCallback?: (id: number, ...args: unknown[]) => unknown
      transformCallback?: (callback: (...args: unknown[]) => unknown) => number
      unregisterCallback?: (id: number) => void
    }
    type TauriEventInternals = {
      unregisterListener?: (event: string, eventId: number) => void
    }

    const globalWindow = window as typeof window & {
      __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventInternals
      __FLOW_TEST_TAURI__?: {
        settingsStore: Record<string, unknown>
      }
      __TAURI_INTERNALS__?: TauriInternals
    }
    const settingsStore: Record<string, unknown> = {}
    let nextCallbackId = 1
    let nextEventId = 1

    const internals = (globalWindow.__TAURI_INTERNALS__ ??= {})
    const eventInternals = (globalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ ??=
      {})
    const callbacks = (internals.callbacks ??= {})

    globalWindow.__FLOW_TEST_TAURI__ = { settingsStore }
    internals.metadata = {
      currentWebview: { label: 'main' },
      currentWindow: { label: 'main' },
    }
    internals.convertFileSrc = (filePath) => filePath
    internals.transformCallback = (callback) => {
      const id = nextCallbackId++
      callbacks[id] = callback
      return id
    }
    internals.unregisterCallback = (id) => {
      delete callbacks[id]
    }
    internals.runCallback = (id, ...args) => callbacks[id]?.(...args)
    eventInternals.unregisterListener = () => undefined
    internals.invoke = async (command, args) => {
      if (command === 'get_settings') return { ...settingsStore }
      if (command === 'update_settings') {
        Object.assign(settingsStore, args?.settings ?? {})
        return null
      }
      if (command === 'list_books') return []
      if (command === 'list_covers') return []
      if (command === 'take_pending_open_paths') return []
      if (command === 'flush_storage') return null
      if (command === 'plugin:event|listen') return nextEventId++
      if (command === 'plugin:event|unlisten') return null
      if (command.startsWith('plugin:window|is_')) return false
      if (command.startsWith('plugin:window|')) return null
      if (command.startsWith('plugin:webview|')) return null

      return null
    }
  })
}

async function getStoredSourceColor(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        settingsStore: {
          theme?: {
            source?: string
          }
        }
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.settingsStore.theme?.source
  })
}

test('loads without client exceptions and persists source color settings', async ({
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
  await expect(page.locator(settingsButtonSelector)).toBeVisible()
  expect(runtimeErrors).toEqual([])

  await page.keyboard.press(settingsShortcut)

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/Settings|设置/)).toBeVisible()
  await expect(
    dialog.getByRole('heading', { name: /Basic|基础/ }),
  ).toBeVisible()
  await expect(dialog.getByText(/Source Color|源色/)).toBeVisible()

  await dialog.getByRole('button', { name: /#0EA5E9/i }).click()
  await page.locator('input.textfield').fill(sourceColor)
  await page.getByRole('button', { name: /Apply|应用/ }).click()

  await expect(
    dialog.getByRole('button', { name: new RegExp(sourceColor, 'i') }),
  ).toBeVisible()
  await expect.poll(() => getStoredSourceColor(page)).toBe(sourceColor)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  expect(runtimeErrors).toEqual([])
})
