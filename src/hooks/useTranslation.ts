import { useCallback } from 'react'

import locales, { getMessageFallbackLocale, type MessageKey } from '../locales'

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

export function useTranslation() {
  const { locale } = useLocale()

  return useCallback(
    (key: MessageKey, ...replacements: Array<string | number>) => {
      const messages = locales[locale]
      const fallbackMessages = locales[getMessageFallbackLocale(locale)]
      const message = messages[key] ?? fallbackMessages[key] ?? key

      return replacements.length > 0 ? formatTranslation(message, replacements).join('') : message
    },
    [locale],
  )
}
