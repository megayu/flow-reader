import { useCallback } from 'react'

import locales, { defaultLocale } from '../locales'

import { useLocale } from './useLocale'

export function useTranslation(scope?: string) {
  const { locale } = useLocale()

  return useCallback(
    (key: string) => {
      const messageKey = scope ? `${scope}.${key}` : key
      const messages = locales[locale] ?? locales[defaultLocale]

      return (
        messages[messageKey as keyof typeof messages] ??
        locales[defaultLocale][
          messageKey as keyof (typeof locales)[typeof defaultLocale]
        ] ??
        key
      )
    },
    [locale, scope],
  )
}
