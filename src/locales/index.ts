import en_US from './en-US.json'
import zh_CN from './zh-CN.json'

// Locale display names
export const localeNames: Record<string, string> = {
  'en-US': 'English',
  'zh-CN': '简体中文',
}

type MessageKey = keyof typeof en_US | keyof typeof zh_CN

const messages = {
  'en-US': en_US satisfies Record<MessageKey, string>,
  'zh-CN': zh_CN satisfies Record<MessageKey, string>,
} as const

export type AppLocale = keyof typeof messages

export const fallbackLocale: AppLocale = 'en-US'
export const localeOptions = Object.keys(messages) as AppLocale[]

export function isAppLocale(locale: string | undefined): locale is AppLocale {
  return !!locale && locale in messages
}

export function toMessageKeySegment(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

export function resolveSystemLocale(languages: readonly string[]): AppLocale {
  const language = languages.find((language) => language.trim())
  const baseLanguage = language?.trim().replaceAll('_', '-').split('-')[0]?.toLowerCase()

  if (baseLanguage === 'en') return 'en-US'
  if (baseLanguage === 'zh') return 'zh-CN'

  return fallbackLocale
}

export default messages
