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
      const { invoke } = await import('@tauri-apps/api/core')
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
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('toggle_devtools')
  } catch {
    // Not running in Tauri.
  }
}
