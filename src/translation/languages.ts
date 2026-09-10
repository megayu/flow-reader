import type { AppLocale } from '../locales'

export const TRANSLATION_LANGUAGES = [
  { id: 'zh-Hans', label: '简体中文', appLocale: 'zh-CN' },
  { id: 'en', label: 'English', appLocale: 'en-US' },
  { id: 'de', label: 'Deutsch', appLocale: 'de-DE' },
  { id: 'es', label: 'Español', appLocale: 'es-ES' },
  { id: 'fr', label: 'Français', appLocale: 'fr-FR' },
  { id: 'it', label: 'Italiano', appLocale: 'it-IT' },
  { id: 'ja', label: '日本語', appLocale: 'ja-JP' },
  { id: 'ko', label: '한국어', appLocale: 'ko-KR' },
  { id: 'nl', label: 'Nederlands', appLocale: 'nl-NL' },
  { id: 'pl', label: 'Polski', appLocale: 'pl-PL' },
  { id: 'pt-BR', label: 'Português (Brasil)', appLocale: 'pt-BR' },
  { id: 'ru', label: 'Русский', appLocale: 'ru-RU' },
  { id: 'zh-Hant', label: '繁體中文', appLocale: 'zh-TW' },
] as const

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]['id']
export type TranslationProvider = 'google' | 'azure'
export type TranslationSourceLanguage = TranslationLanguage | 'auto'

const LANGUAGE_IDS = new Set<string>(TRANSLATION_LANGUAGES.map((language) => language.id))

const unique = <T>(values: T[]) => [...new Set(values)]

export function translationLanguageForAppLocale(locale: AppLocale): TranslationLanguage {
  return TRANSLATION_LANGUAGES.find(({ appLocale }) => appLocale === locale)!.id
}

export function orderedSourceLanguages(
  mainLanguage: TranslationLanguage,
  secondaryLanguage: TranslationLanguage,
): TranslationSourceLanguage[] {
  return unique([
    'auto' as const,
    mainLanguage,
    secondaryLanguage,
    ...TRANSLATION_LANGUAGES.map((language) => language.id),
  ])
}

export function orderedTargetLanguages(
  mainLanguage: TranslationLanguage,
  secondaryLanguage: TranslationLanguage,
): TranslationLanguage[] {
  return unique([mainLanguage, secondaryLanguage, ...TRANSLATION_LANGUAGES.map((language) => language.id)])
}

export function providerLanguageCode(provider: TranslationProvider, language: TranslationSourceLanguage): string {
  if (language === 'auto') return provider === 'google' ? 'auto' : ''
  if (provider === 'google' && language === 'zh-Hans') return 'zh-CN'
  if (provider === 'google' && language === 'zh-Hant') return 'zh-TW'
  return language
}

function normalizeLanguage(language?: string): TranslationLanguage | undefined {
  if (!language) return undefined

  const normalized = language.trim().replace('_', '-').toLowerCase()
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized)) return 'zh-Hans'
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(normalized)) return 'zh-Hant'
  if (/^pt(-|$)/.test(normalized)) return 'pt-BR'

  const exact = TRANSLATION_LANGUAGES.find(({ id }) => id.toLowerCase() === normalized)?.id
  if (exact) return exact

  const base = normalized.split('-')[0] ?? ''
  return LANGUAGE_IDS.has(base) ? (base as TranslationLanguage) : undefined
}

function inferScriptLanguage(
  text: string,
  mainLanguage: TranslationLanguage,
  secondaryLanguage: TranslationLanguage,
): TranslationLanguage | undefined {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko'

  if (/[\u3400-\u9fff]/u.test(text)) {
    const configuredChinese = unique([mainLanguage, secondaryLanguage].filter((language) => language.startsWith('zh-')))
    if (configuredChinese.length === 1) return configuredChinese[0]
  }

  return undefined
}

function firstLanguageCharacter(text: string): string | undefined {
  for (const character of text) {
    if (!/^[\p{N}\p{P}\p{Z}\s]$/u.test(character)) return character
  }
}

function characterMatchesLanguage(character: string, language: TranslationLanguage): boolean {
  if (language.startsWith('zh-')) return /^\p{Script=Han}$/u.test(character)
  if (language === 'ja') {
    return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(character)
  }
  if (language === 'ko') return /^[\p{Script=Han}\p{Script=Hangul}]$/u.test(character)
  if (language === 'ru') return /^\p{Script=Cyrillic}$/u.test(character)
  return /^\p{Script=Latin}$/u.test(character)
}

export function resolveTranslationDirection({
  declaredLanguage,
  mainLanguage,
  secondaryLanguage,
  text,
}: {
  declaredLanguage?: string
  mainLanguage: TranslationLanguage
  secondaryLanguage: TranslationLanguage
  text: string
}): {
  sourceLanguage: TranslationSourceLanguage
  targetLanguage: TranslationLanguage
} {
  const normalizedDeclaredLanguage = normalizeLanguage(declaredLanguage)
  const languageCharacter = firstLanguageCharacter(text)
  if (
    normalizedDeclaredLanguage &&
    languageCharacter &&
    !characterMatchesLanguage(languageCharacter, normalizedDeclaredLanguage)
  ) {
    return {
      sourceLanguage: 'auto',
      targetLanguage: mainLanguage,
    }
  }

  const sourceLanguage =
    normalizedDeclaredLanguage ?? inferScriptLanguage(text, mainLanguage, secondaryLanguage) ?? 'auto'

  return {
    sourceLanguage,
    targetLanguage: sourceLanguage === mainLanguage ? secondaryLanguage : mainLanguage,
  }
}
