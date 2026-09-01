import { useCallback } from 'react'

import locales, { getMessageFallbackLocale } from '../locales'

import { useLocale } from './useLocale'

export function formatTranslation<T>(message: string, replacements: readonly T[]): Array<string | T> {
  const parts: Array<string | T> = []
  let offset = 0

  for (const match of message.matchAll(/\{([1-9]\d*)\}/g)) {
    const index = match.index
    const replacementIndex = Number(match[1]) - 1

    if (index > offset) parts.push(message.slice(offset, index))
    parts.push(replacementIndex < replacements.length ? replacements[replacementIndex]! : match[0])
    offset = index + match[0].length
  }

  if (offset < message.length) parts.push(message.slice(offset))
  return parts
}

export function useTranslation(scope?: string) {
  const { locale } = useLocale()

  return useCallback(
    (key: string, ...replacements: Array<string | number>) => {
      const messageKey = scope ? `${scope}.${key}` : key
      const messages = locales[locale]
      const fallbackMessages = locales[getMessageFallbackLocale(locale)]
      const message =
        messages[messageKey as keyof typeof messages] ??
        fallbackMessages[messageKey as keyof typeof fallbackMessages] ??
        key

      return replacements.length > 0 ? formatTranslation(message, replacements).join('') : message
    },
    [locale, scope],
  )
}
