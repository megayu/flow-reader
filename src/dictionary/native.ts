import { invoke } from '@tauri-apps/api/core'

export interface DictionaryHttpResponse {
  body: string
  finalUrl: string
  status: number
}

export interface DictionaryHttpError {
  code: string
  message: string
}

export function fetchZdic(query: string, sessionId: number) {
  return invoke<DictionaryHttpResponse>('fetch_zdic', { query, sessionId })
}

export function fetchMerriamWebster(
  query: string,
  key: string,
  sessionId: number,
) {
  return invoke<DictionaryHttpResponse>('fetch_merriam_webster', {
    query,
    key,
    sessionId,
  })
}

export function cancelDictionarySession(sessionId: number) {
  return invoke<void>('cancel_dictionary_session', { sessionId })
}
