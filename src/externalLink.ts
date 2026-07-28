import { invoke } from '@tauri-apps/api/core'

import { IS_SERVER, isTauriRuntime } from '@/env'

export function isSupportedExternalUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'mailto:'
    )
  } catch {
    return false
  }
}

export async function openSupportedExternalUrl(url: string) {
  if (IS_SERVER || !isSupportedExternalUrl(url)) return false

  if (!isTauriRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  }

  await invoke('open_external_url', { url })
  return true
}
