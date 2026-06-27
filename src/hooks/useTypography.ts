import { useMemo } from 'react'
import { useSnapshot } from 'valtio'

import { BookTab } from '../models/reader'
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
  const { typographyConfiguration } = useSnapshot(tab)
  const [settings] = useSettings()
  const zenTypographyOverrides = useZenTypographyOverrides()
  const zenTypography = zenTypographyOverrides[tab.id]

  return useMemo(
    () => ({
      spread: settings.spread,
      textAlign: settings.textAlign,
      hideEndnotes: settings.hideEndnotes,
      ...removeUndefinedProperty(typographyConfiguration ?? {}),
      ...removeUndefinedProperty(zenTypography ?? {}),
    }),
    [
      settings.hideEndnotes,
      settings.spread,
      settings.textAlign,
      typographyConfiguration,
      zenTypography,
    ],
  )
}
