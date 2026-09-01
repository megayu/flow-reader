export const TRANSLATION_LANGUAGES = [
  { id: 'zh-Hans', label: '简体中文' },
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'it', label: 'Italiano' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'nl', label: 'Nederlands' },
  { id: 'pl', label: 'Polski' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'ru', label: 'Русский' },
  { id: 'zh-Hant', label: '繁體中文' },
] as const

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]['id']
export type TranslationProvider = 'google' | 'azure'
export type TranslationSourceLanguage = TranslationLanguage | 'auto'

const LANGUAGE_IDS = new Set<string>(TRANSLATION_LANGUAGES.map((language) => language.id))

const unique = <T>(values: T[]) => [...new Set(values)]

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
