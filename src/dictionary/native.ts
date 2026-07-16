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

export type LocalDictionaryFormat = 'mdict' | 'stardict'
export type LocalDictionaryLanguage = 'en' | 'unknown' | 'zh'
export type LocalDictionaryLanguageSource =
  | 'manual'
  | 'metadata'
  | 'sample'
  | 'unknown'
export type LocalDictionarySourceStatus = 'available' | 'changed' | 'missing'

export interface LocalDictionaryRecord {
  createdAt: number
  enabled: boolean
  files: Array<{
    kind:
      | 'compressedData'
      | 'cover'
      | 'data'
      | 'index'
      | 'resources'
      | 'synonyms'
    path: string
    used: boolean
  }>
  fingerprint: {
    modifiedMs: number
    sampleHash: string
    size: number
  }
  format: LocalDictionaryFormat
  id: string
  language: {
    source: LocalDictionaryLanguageSource
    value: LocalDictionaryLanguage
  }
  name: string
  order: number
  sourcePath: string
  sourceStatus: LocalDictionarySourceStatus
  updatedAt: number
}

export interface LocalDictionaryUpdate {
  enabled?: boolean
  language?: LocalDictionaryLanguage
  order?: number
}

export interface StarDictLookupResponse {
  diagnostics: {
    bytesRead: number
    decompressedBlocks: number
  }
  entries: Array<{
    definitions: string[]
    headword: string
  }>
}

let localDictionaryListCache: Promise<LocalDictionaryRecord[]> | undefined

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

export function listLocalDictionaries() {
  const request = invoke<LocalDictionaryRecord[]>('list_local_dictionaries')
  localDictionaryListCache = request
  void request.catch(() => {
    if (localDictionaryListCache === request) {
      localDictionaryListCache = undefined
    }
  })
  return request
}

export function listLocalDictionariesCached() {
  return localDictionaryListCache ?? listLocalDictionaries()
}

export function registerLocalDictionary(path: string) {
  return invoke<LocalDictionaryRecord>('register_local_dictionary', {
    path,
  }).then((record) => {
    localDictionaryListCache = undefined
    return record
  })
}

export function updateLocalDictionary(
  id: string,
  changes: LocalDictionaryUpdate,
) {
  return invoke<LocalDictionaryRecord>('update_local_dictionary', {
    id,
    changes,
  }).then((record) => {
    localDictionaryListCache = undefined
    return record
  })
}

export function relocateLocalDictionary(id: string, path: string) {
  return invoke<LocalDictionaryRecord>('relocate_local_dictionary', {
    id,
    path,
  }).then((record) => {
    localDictionaryListCache = undefined
    return record
  })
}

export function removeLocalDictionary(id: string) {
  return invoke<void>('remove_local_dictionary', { id }).then(() => {
    localDictionaryListCache = undefined
  })
}

export function lookupStarDict(
  dictionaryId: string,
  query: string,
  sessionId: number,
) {
  return invoke<StarDictLookupResponse>('lookup_stardict', {
    dictionaryId,
    query,
    sessionId,
  })
}
