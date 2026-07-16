import type { DictionaryQuery, DictionaryQueryLanguage } from './types'

export const MAX_DICTIONARY_QUERY_LENGTH = 128

const outerPunctuationOrSymbol = /^[\p{P}\p{S}]$/u
const hanCharacter = /\p{Script=Han}/u
const latinCharacter = /\p{Script=Latin}/u

export function classifyDictionaryQuery(text: string): DictionaryQueryLanguage {
  const hasHan = hanCharacter.test(text)
  const hasLatin = latinCharacter.test(text)

  if (hasHan && hasLatin) return 'mixed'
  if (hasHan) return 'zh'
  if (hasLatin) return 'en'
  return 'unknown'
}

export function normalizeDictionaryQuery(
  rawText: string,
): DictionaryQuery | null {
  if (/\r|\n/u.test(rawText)) return null

  const normalized = rawText.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const characters = Array.from(normalized)

  while (characters[0] && outerPunctuationOrSymbol.test(characters[0])) {
    characters.shift()
  }
  while (
    characters.length > 0 &&
    outerPunctuationOrSymbol.test(characters[characters.length - 1] ?? '')
  ) {
    characters.pop()
  }

  const text = characters.join('').trim()
  if (!text || Array.from(text).length > MAX_DICTIONARY_QUERY_LENGTH)
    return null

  return {
    language: classifyDictionaryQuery(text),
    text,
  }
}
