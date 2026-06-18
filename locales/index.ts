import de_DE from '../locales/de-DE'
import en_US from '../locales/en-US'
import ja_JP from '../locales/ja-JP'
import zh_CN from '../locales/zh-CN'

// Locale display names
export const localeNames: Record<string, string> = {
  'en-US': 'English',
  'zh-CN': '简体中文',
  'ja-JP': '日本語',
  'de-DE': 'Deutsch',
}

const messages = {
  'en-US': en_US,
  'zh-CN': zh_CN,
  'ja-JP': ja_JP,
  'de-DE': de_DE,
} as const

export type AppLocale = keyof typeof messages

export const defaultLocale: AppLocale = 'zh-CN'
export const localeOptions = Object.keys(messages) as AppLocale[]

export function isAppLocale(locale: string | undefined): locale is AppLocale {
  return !!locale && locale in messages
}

export default messages
