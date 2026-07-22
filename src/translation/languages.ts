export const TRANSLATION_LANGUAGES = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'it', label: 'Italiano' },
  { id: 'nl', label: 'Nederlands' },
  { id: 'pl', label: 'Polski' },
  { id: 'pt', label: 'Português' },
  { id: 'ru', label: 'Русский' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'zh-Hans', label: '简体中文' },
  { id: 'zh-Hant', label: '繁體中文' },
] as const

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]['id']
export type TranslationProvider = 'google' | 'azure'
export type TranslationSourceLanguage = TranslationLanguage | 'auto'

const LANGUAGE_IDS = new Set<string>(
  TRANSLATION_LANGUAGES.map((language) => language.id),
)

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
  return unique([
    mainLanguage,
    secondaryLanguage,
    ...TRANSLATION_LANGUAGES.map((language) => language.id),
  ])
}

export function providerLanguageCode(
  provider: TranslationProvider,
  language: TranslationSourceLanguage,
): string {
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

  const exact = TRANSLATION_LANGUAGES.find(
    ({ id }) => id.toLowerCase() === normalized,
  )?.id
  if (exact) return exact

  const base = normalized.split('-')[0] ?? ''
  return LANGUAGE_IDS.has(base) ? (base as TranslationLanguage) : undefined
}

function inferScriptLanguage(
  text: string,
  mainLanguage: TranslationLanguage,
  secondaryLanguage: TranslationLanguage,
): TranslationLanguage | undefined {
  if (/[぀-ヿ]/u.test(text)) return 'ja'
  if (/[가-힯]/u.test(text)) return 'ko'

  if (/[㐀-鿿]/u.test(text)) {
    const configuredChinese = unique(
      [mainLanguage, secondaryLanguage].filter((language) =>
        language.startsWith('zh-'),
      ),
    )
    if (configuredChinese.length === 1) return configuredChinese[0]
  }

  return undefined
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
  const sourceLanguage =
    normalizeLanguage(declaredLanguage) ??
    inferScriptLanguage(text, mainLanguage, secondaryLanguage) ??
    'auto'

  return {
    sourceLanguage,
    targetLanguage:
      sourceLanguage === mainLanguage ? secondaryLanguage : mainLanguage,
  }
}
