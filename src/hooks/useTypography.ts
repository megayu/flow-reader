import { useMemo } from 'react'
import { useSnapshot } from 'valtio'

import type { BookTab } from '../models/reader'
import { resolveBookSpreadPolicy } from '../reader/spreadPolicy'
import { useSettings, useZenTypographyOverrides } from '../state'

function removeUndefinedProperty<T extends Record<string, any>>(obj: T) {
  const newObj: Partial<T> = {}

  Object.entries(obj).forEach(([k, v]) => {
    if (v !== undefined) {
      newObj[k as keyof T] = v
    }
  })

  return newObj
}

export function useTypography(tab: BookTab) {
  const { book, typographyConfiguration } = useSnapshot(tab)
  const [settings] = useSettings()
  const zenTypographyOverrides = useZenTypographyOverrides()
  const zenTypography = zenTypographyOverrides[tab.id]

  return useMemo(
    () => ({
      textAlign: settings.textAlign,
      hideEndnotes: settings.hideEndnotes,
      ...removeUndefinedProperty(typographyConfiguration ?? {}),
      ...removeUndefinedProperty(zenTypography ?? {}),
      spread: resolveBookSpreadPolicy({
        temporaryOverride: zenTypography?.spread,
        perBookOverride: typographyConfiguration?.spread,
        publicationSpread: book.metadata.spread,
        applicationDefault: settings.spread,
      }),
    }),
    [
      book.metadata.spread,
      settings.hideEndnotes,
      settings.spread,
      settings.textAlign,
      typographyConfiguration,
      zenTypography,
    ],
  )
}
