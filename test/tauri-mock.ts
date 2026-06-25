import type { Page } from '@playwright/test'

export async function installTauriMock(page: Page) {
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
    const settingsStore: Record<string, unknown> = { locale: 'en-US' }
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

export async function getStoredSettings(page: Page) {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      __FLOW_TEST_TAURI__?: {
        settingsStore: Record<string, unknown>
      }
    }

    return globalWindow.__FLOW_TEST_TAURI__?.settingsStore ?? {}
  })
}
