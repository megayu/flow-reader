import { invoke } from '@tauri-apps/api/core'

import type { TranslationProvider } from './languages'

interface NativeTranslationResponse {
  bodies: string[]
}

let nextSessionId = 1

export async function fetchNativeTranslation(request: {
  provider: TranslationProvider
  texts: string[]
  sourceLanguage: string
  targetLanguage: string
  signal?: AbortSignal
}): Promise<string[]> {
  const sessionId = nextSessionId++
  const abort = () => {
    void invoke('cancel_translation_session', { sessionId })
  }
  request.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await invoke<NativeTranslationResponse>('fetch_translation', {
      request: {
        provider: request.provider,
        texts: request.texts,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        sessionId,
      },
    })
    return response.bodies
  } finally {
    request.signal?.removeEventListener('abort', abort)
  }
}
