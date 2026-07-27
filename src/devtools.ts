import { invoke } from '@tauri-apps/api/core'

let devtoolsShortcutEnabled = import.meta.env.DEV
let devtoolsShortcutEnabledPromise: Promise<boolean> | undefined

export function isDevtoolsShortcutEnabled() {
  return devtoolsShortcutEnabled
}

export async function loadDevtoolsShortcutEnabled() {
  if (import.meta.env.DEV) {
    devtoolsShortcutEnabled = true
    return true
  }

  devtoolsShortcutEnabledPromise ??= (async () => {
    try {
      devtoolsShortcutEnabled = await invoke<boolean>('is_devtools_enabled')
    } catch {
      devtoolsShortcutEnabled = false
    }

    return devtoolsShortcutEnabled
  })()

  return devtoolsShortcutEnabledPromise
}

export async function toggleDevtools() {
  if (!(await loadDevtoolsShortcutEnabled())) return

  try {
    await invoke('toggle_devtools')
  } catch {
    // Not running in Tauri.
  }
}
