import { expect, test } from 'vitest'

import {
  orderedSourceLanguages,
  orderedTargetLanguages,
  providerLanguageCode,
  resolveTranslationDirection,
} from '../../src/translation/languages'
import { parseAzureTranslationResponse } from '../../src/translation/providers/azure'
import { parseGoogleTranslationResponse } from '../../src/translation/providers/google'
import {
  joinTranslationSections,
  splitTranslationSections,
} from '../../src/translation/serialize'

test.describe('translation language contract', () => {
  test('pins automatic detection, main language, and secondary language before the fixed list', () => {
    expect(orderedSourceLanguages('zh-Hans', 'en').slice(0, 6)).toEqual([
      'auto',
      'zh-Hans',
      'en',
      'de',
      'es',
      'fr',
    ])
    expect(orderedTargetLanguages('zh-Hans', 'en').slice(0, 5)).toEqual([
      'zh-Hans',
      'en',
      'de',
      'es',
      'fr',
    ])
    expect(new Set(orderedSourceLanguages('zh-Hans', 'en')).size).toBe(
      orderedSourceLanguages('zh-Hans', 'en').length,
    )
  })

  test('maps shared language ids only at the provider boundary', () => {
    expect(providerLanguageCode('google', 'zh-Hans')).toBe('zh-CN')
    expect(providerLanguageCode('google', 'zh-Hant')).toBe('zh-TW')
    expect(providerLanguageCode('azure', 'zh-Hans')).toBe('zh-Hans')
    expect(providerLanguageCode('azure', 'zh-Hant')).toBe('zh-Hant')
    expect(providerLanguageCode('google', 'fr')).toBe('fr')
  })

  test('routes the main language to the secondary language and every other or unknown language to the main language', () => {
    expect(
      resolveTranslationDirection({
        declaredLanguage: 'zh-CN',
        mainLanguage: 'zh-Hans',
        secondaryLanguage: 'en',
        text: '合成文本',
      }),
    ).toEqual({ sourceLanguage: 'zh-Hans', targetLanguage: 'en' })

    expect(
      resolveTranslationDirection({
        declaredLanguage: 'fr-FR',
        mainLanguage: 'zh-Hans',
        secondaryLanguage: 'en',
        text: 'texte synthétique',
      }),
    ).toEqual({ sourceLanguage: 'fr', targetLanguage: 'zh-Hans' })

    expect(
      resolveTranslationDirection({
        mainLanguage: 'zh-Hans',
        secondaryLanguage: 'en',
        text: '空を見る',
      }),
    ).toEqual({ sourceLanguage: 'ja', targetLanguage: 'zh-Hans' })

    expect(
      resolveTranslationDirection({
        mainLanguage: 'en',
        secondaryLanguage: 'zh-Hans',
        text: 'synthetic text',
      }),
    ).toEqual({ sourceLanguage: 'auto', targetLanguage: 'en' })
  })
})

test.describe('translation payload contract', () => {
  test('preserves chapter boundaries while discarding empty outer sections', () => {
    expect(
      joinTranslationSections([
        '  first paragraph\nsecond paragraph  ',
        '',
        '  next chapter  ',
      ]),
    ).toBe('first paragraph\nsecond paragraph\n\nnext chapter')

    expect(splitTranslationSections('chapter one\n\nchapter two')).toEqual([
      'chapter one',
      'chapter two',
    ])
  })

  test('unpacks Google and Azure responses into one result per input', () => {
    expect(
      parseGoogleTranslationResponse(
        JSON.stringify([
          [
            ['Hello ', '你好 ', null, null],
            ['world', '世界', null, null],
          ],
          null,
          'zh-CN',
        ]),
      ),
    ).toEqual(['Hello world'])

    expect(
      parseAzureTranslationResponse(
        JSON.stringify([
          { translations: [{ text: 'Hello', to: 'en' }] },
          { translations: [{ text: 'World', to: 'en' }] },
        ]),
        2,
      ),
    ).toEqual(['Hello', 'World'])
  })

  test('rejects malformed or incomplete provider responses', () => {
    expect(() => parseGoogleTranslationResponse('{}')).toThrow(
      'Invalid Google translation response',
    )
    expect(() =>
      parseAzureTranslationResponse(
        JSON.stringify([{ translations: [{ text: 'Only one', to: 'en' }] }]),
        2,
      ),
    ).toThrow('Invalid Azure translation response')
  })
})
