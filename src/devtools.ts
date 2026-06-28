export const devtoolsShortcutEnabled = process.env.NODE_ENV !== 'production'

export async function toggleDevtools() {
  if (!devtoolsShortcutEnabled) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('toggle_devtools')
  } catch {
    // Not running in Tauri.
  }
}
