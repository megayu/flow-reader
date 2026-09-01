import { describe, expect, it } from 'vitest'

import messages, { type AppLocale, fallbackLocale, localeOptions, resolveSystemLocale } from '../../src/locales'

describe('Locales and i18n contract', () => {
  const baseKeys = Object.keys(messages[fallbackLocale]).sort()

  it('ensures placeholder tokens ({1}, {2}, etc.) match the base translation for all messages', () => {
    const placeholderRegex = /\{(\d+)\}/g

    for (const key of baseKeys) {
      const baseMessage = messages[fallbackLocale][key as keyof (typeof messages)['en-US']]
      const basePlaceholders = (baseMessage.match(placeholderRegex) || []).sort()

      for (const locale of localeOptions) {
        const localeMessage = messages[locale][key as keyof (typeof messages)['en-US']]
        const localePlaceholders = (localeMessage.match(placeholderRegex) || []).sort()
        expect(localePlaceholders).toEqual(basePlaceholders)
      }
    }
  })

  it('resolves system locales accurately to corresponding AppLocale', () => {
    const cases: [readonly string[], AppLocale][] = [
      [['zh-TW'], 'zh-TW'],
      [['zh-HK'], 'zh-TW'],
      [['zh-Hant'], 'zh-TW'],
      [['zh-CN'], 'zh-CN'],
      [['zh-Hans'], 'zh-CN'],
      [['zh'], 'zh-CN'],
      [['ja', 'en-US'], 'ja-JP'],
      [['ja-JP'], 'ja-JP'],
      [['ko', 'en-US'], 'ko-KR'],
      [['ko-KR'], 'ko-KR'],
      [['de', 'en'], 'de-DE'],
      [['de-AT'], 'de-DE'],
      [['es', 'en'], 'es-ES'],
      [['es-MX'], 'es-ES'],
      [['fr', 'en'], 'fr-FR'],
      [['it', 'en'], 'it-IT'],
      [['nl', 'en'], 'nl-NL'],
      [['pl', 'en'], 'pl-PL'],
      [['pt', 'en'], 'pt-BR'],
      [['pt-PT'], 'pt-BR'],
      [['pt-BR'], 'pt-BR'],
      [['ru', 'en'], 'ru-RU'],
      [['en'], 'en-US'],
      [['unknown-lang', 'fr-FR'], 'fr-FR'],
      [['unknown-lang'], 'en-US'],
    ]

    for (const [languages, expected] of cases) {
      expect(resolveSystemLocale(languages)).toBe(expected)
    }
  })
})
