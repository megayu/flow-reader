import de_DE from './de-DE.json'
import en_US from './en-US.json'
import es_ES from './es-ES.json'
import fr_FR from './fr-FR.json'
import it_IT from './it-IT.json'
import ja_JP from './ja-JP.json'
import ko_KR from './ko-KR.json'
import nl_NL from './nl-NL.json'
import pl_PL from './pl-PL.json'
import pt_BR from './pt-BR.json'
import ru_RU from './ru-RU.json'
import zh_CN from './zh-CN.json'
import zh_TW from './zh-TW.json'

export type MessageKey = keyof typeof en_US

const messages = {
  'zh-CN': zh_CN satisfies Record<MessageKey, string>,
  'en-US': en_US satisfies Record<MessageKey, string>,
  'de-DE': de_DE satisfies Record<MessageKey, string>,
  'es-ES': es_ES satisfies Record<MessageKey, string>,
  'fr-FR': fr_FR satisfies Record<MessageKey, string>,
  'it-IT': it_IT satisfies Record<MessageKey, string>,
  'ja-JP': ja_JP satisfies Record<MessageKey, string>,
  'ko-KR': ko_KR satisfies Record<MessageKey, string>,
  'nl-NL': nl_NL satisfies Record<MessageKey, string>,
  'pl-PL': pl_PL satisfies Record<MessageKey, string>,
  'pt-BR': pt_BR satisfies Record<MessageKey, string>,
  'ru-RU': ru_RU satisfies Record<MessageKey, string>,
  'zh-TW': zh_TW satisfies Record<MessageKey, string>,
} as const

export type AppLocale = keyof typeof messages

// Locale display names
export const localeNames: Record<AppLocale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
  'de-DE': 'Deutsch',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'nl-NL': 'Nederlands',
  'pl-PL': 'Polski',
  'pt-BR': 'Português (Brasil)',
  'ru-RU': 'Русский',
  'zh-TW': '繁體中文',
}

export const fallbackLocale: AppLocale = 'en-US'
export const localeOptions = Object.keys(messages) as AppLocale[]

export function getMessageFallbackLocale(locale: AppLocale): AppLocale {
  return locale === 'zh-TW' ? 'zh-CN' : fallbackLocale
}

export function isAppLocale(locale: string | undefined): locale is AppLocale {
  return !!locale && locale in messages
}

export function toMessageKeySegment(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

export function resolveSystemLocale(languages: readonly string[]): AppLocale {
  for (const language of languages) {
    const normalized = language.trim().replaceAll('_', '-').toLowerCase()
    if (!normalized) continue
    if (/^zh-(hant|tw|hk|mo)(-|$)/.test(normalized)) return 'zh-TW'
    if (/^zh(-|$)/.test(normalized)) return 'zh-CN'

    const baseLanguage = normalized.split('-')[0]

    switch (baseLanguage) {
      case 'en':
        return 'en-US'
      case 'de':
        return 'de-DE'
      case 'es':
        return 'es-ES'
      case 'fr':
        return 'fr-FR'
      case 'it':
        return 'it-IT'
      case 'ja':
        return 'ja-JP'
      case 'ko':
        return 'ko-KR'
      case 'nl':
        return 'nl-NL'
      case 'pl':
        return 'pl-PL'
      case 'pt':
        return 'pt-BR'
      case 'ru':
        return 'ru-RU'
    }
  }

  return fallbackLocale
}

export default messages
