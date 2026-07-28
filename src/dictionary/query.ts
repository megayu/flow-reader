import type { DictionaryQuery, DictionaryQueryLanguage, SupportedDictionaryLanguage } from './types'

export const MAX_DICTIONARY_QUERY_LENGTH = 24
export const MAX_DICTIONARY_QUERY_LETTER_LENGTH = 16

const ignoredLanguageCharacter = /^[\p{M}\p{N}\p{P}\p{Z}\s]$/u
const scriptPatterns = {
  cyrillic: /^\p{Script=Cyrillic}$/u,
  han: /^\p{Script=Han}$/u,
  hangul: /^\p{Script=Hangul}$/u,
  hiragana: /^\p{Script=Hiragana}$/u,
  katakana: /^\p{Script=Katakana}$/u,
  latin: /^\p{Script=Latin}$/u,
} as const
type QueryScript = keyof typeof scriptPatterns

const exactLanguageAliases: Partial<Record<SupportedDictionaryLanguage, readonly string[]>> = {
  de: ['de', 'deu', 'ger', 'german', 'deutsch'],
  es: ['es', 'spa', 'spanish', 'español'],
  fr: ['fr', 'fra', 'fre', 'french', 'français'],
  it: ['it', 'ita', 'italian', 'italiano'],
  ja: ['ja', 'jpn', 'japanese', '日本語'],
  ko: ['ko', 'kor', 'korean', '한국어'],
  nl: ['nl', 'nld', 'dut', 'dutch', 'nederlands'],
  pl: ['pl', 'pol', 'polish', 'polski'],
  pt: ['pt', 'por', 'portuguese', 'português'],
  ru: ['ru', 'rus', 'russian', 'русский'],
}

export function normalizeDictionaryLanguage(language?: string): SupportedDictionaryLanguage | undefined {
  const normalized = language?.trim().replaceAll('_', '-').toLowerCase()
  if (!normalized) return

  if (
    normalized === 'zh' ||
    normalized.startsWith('zh-') ||
    ['zho', 'chi', 'chinese', '中文', '汉语', '漢語'].includes(normalized)
  ) {
    return 'zh'
  }
  if (
    normalized === 'en' ||
    normalized.startsWith('en-') ||
    ['eng', 'english', '英文', '英语', '英語'].includes(normalized)
  ) {
    return 'en'
  }

  return Object.entries(exactLanguageAliases).find(([, aliases]) => aliases?.includes(normalized))?.[0] as
    | SupportedDictionaryLanguage
    | undefined
}

export function classifyDictionaryQuery(text: string, metadataLanguage?: string): DictionaryQueryLanguage {
  const scripts = queryScripts(text)
  if (scripts.size === 0) return 'unknown'

  const candidate = normalizeDictionaryLanguage(metadataLanguage)
  if (candidate && scriptsMatchLanguage(scripts, candidate)) return candidate

  if (isExactScriptSet(scripts, ['latin'])) return 'en'
  if (isExactScriptSet(scripts, ['cyrillic'])) return 'ru'
  if (isExactScriptSet(scripts, ['han'])) return 'zh'
  if (isJapaneseScriptSet(scripts)) return 'ja'
  if (isKoreanScriptSet(scripts)) return 'ko'

  return scripts.has('other') ? 'unknown' : 'mixed'
}

export function normalizeDictionaryQuery(rawText: string, metadataLanguage?: string): DictionaryQuery | null {
  const text = rawText.trim()
  if (!text || /\p{Cc}/u.test(text)) return null

  const characters = Array.from(text)
  if (characters.length > MAX_DICTIONARY_QUERY_LENGTH) return null

  const meaningfulLength = characters.filter((character) => !ignoredLanguageCharacter.test(character)).length
  if (meaningfulLength === 0 || meaningfulLength > MAX_DICTIONARY_QUERY_LETTER_LENGTH) {
    return null
  }

  const language = classifyDictionaryQuery(text, metadataLanguage)
  if (language === 'mixed' || language === 'unknown') return null

  return {
    language,
    text,
  }
}

function queryScripts(text: string) {
  const scripts = new Set<QueryScript | 'other'>()
  for (const character of text) {
    if (ignoredLanguageCharacter.test(character)) continue
    const script = Object.entries(scriptPatterns).find(([, pattern]) => pattern.test(character))?.[0] as
      | QueryScript
      | undefined
    scripts.add(script ?? 'other')
  }
  return scripts
}

function scriptsMatchLanguage(scripts: ReadonlySet<QueryScript | 'other'>, language: SupportedDictionaryLanguage) {
  if (language === 'zh') return isExactScriptSet(scripts, ['han'])
  if (language === 'ja') return isJapaneseScriptSet(scripts)
  if (language === 'ko') return isKoreanScriptSet(scripts)
  if (language === 'ru') return isExactScriptSet(scripts, ['cyrillic'])
  return isExactScriptSet(scripts, ['latin'])
}

function isJapaneseScriptSet(scripts: ReadonlySet<string>) {
  return (
    hasOnlyScripts(scripts, ['han', 'hiragana', 'katakana']) &&
    (scripts.has('han') || scripts.has('hiragana') || scripts.has('katakana'))
  )
}

function isKoreanScriptSet(scripts: ReadonlySet<string>) {
  return hasOnlyScripts(scripts, ['han', 'hangul']) && (scripts.has('han') || scripts.has('hangul'))
}

function isExactScriptSet(scripts: ReadonlySet<string>, expected: readonly string[]) {
  return scripts.size === expected.length && hasOnlyScripts(scripts, expected)
}

function hasOnlyScripts(scripts: ReadonlySet<string>, expected: readonly string[]) {
  return [...scripts].every((script) => expected.includes(script))
}
