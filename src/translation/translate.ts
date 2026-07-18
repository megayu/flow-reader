import {
  providerLanguageCode,
  type TranslationLanguage,
  type TranslationProvider,
  type TranslationSourceLanguage,
} from './languages'
import { fetchNativeTranslation } from './native'
import { parseAzureTranslationResponse } from './providers/azure'
import { parseGoogleTranslationResponses } from './providers/google'

export async function translateTexts({
  provider,
  texts,
  sourceLanguage,
  targetLanguage,
  signal,
}: {
  provider: TranslationProvider
  texts: string[]
  sourceLanguage: TranslationSourceLanguage
  targetLanguage: TranslationLanguage
  signal?: AbortSignal
}): Promise<string[]> {
  const bodies = await fetchNativeTranslation({
    provider,
    texts,
    sourceLanguage: providerLanguageCode(provider, sourceLanguage),
    targetLanguage: providerLanguageCode(provider, targetLanguage),
    signal,
  })
  return provider === 'google'
    ? parseGoogleTranslationResponses(bodies)
    : parseAzureTranslationResponse(bodies[0] ?? '', texts.length)
}
