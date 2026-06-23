import { useSetThemeValue, useThemeValue } from '@flow/reader/state'

export function useTheme() {
  return useThemeValue()
}

export function useSetTheme() {
  return useSetThemeValue()
}
