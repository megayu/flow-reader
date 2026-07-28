export const supportedDictionaryLanguages = [
  'zh',
  'en',
  'ru',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'pl',
  'nl',
  'ja',
  'ko',
] as const

export type SupportedDictionaryLanguage = (typeof supportedDictionaryLanguages)[number]

export type DictionaryQueryLanguage = SupportedDictionaryLanguage | 'mixed' | 'unknown'

export interface DictionaryQuery {
  language: DictionaryQueryLanguage
  text: string
}

export interface DictionaryResult {
  content: DictionaryContent
  externalUrl?: string
  sourceId: string
  sourceName: string
}

export type DictionaryContent =
  | { entries: DictionaryEntry[]; kind: 'entries' }
  | { document: DictionaryRichDocument; kind: 'rich' }

export interface DictionaryEntry {
  headword?: string
  homograph?: number
  partOfSpeech?: string
  pronunciation?: string
  senses: DictionarySense[]
}

export interface DictionarySense {
  definition: DictionaryText
  examples?: DictionaryText[]
  level?: number
  marker?: string
  markerParts?: DictionarySenseMarkerParts
}

export interface DictionarySenseMarkerParts {
  letter?: string
  number?: string
  subnumber?: string
}

export type DictionaryText = { kind: 'plain'; text: string } | { kind: 'runs'; runs: DictionaryTextRun[] }

export interface DictionaryTextRun {
  kind: 'emphasis' | 'label' | 'plain' | 'reference'
  text: string
}

export interface DictionaryRichDocument {
  resourceKeys: string[]
  sanitizedCss: string[]
  sanitizedHtml: string
}
